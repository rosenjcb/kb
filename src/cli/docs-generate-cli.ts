import path from 'node:path'
import type { DocType } from '../core/doc-taxonomy'
import { DOC_TYPES, isDocType } from '../core/doc-taxonomy'
import { appendReferencesFooter } from '../core/doc-references-footer'
import {
  applyAnswer,
  applySkip,
  createSessionRecord,
  firstPendingAnswerIndex,
  listSessionSummaries,
  loadSession,
  markSessionFinalized,
  saveSession,
  type DocGenerateSession,
} from '../core/doc-generate-session'
import { deriveDocumentTitle } from '../core/doc-generate-title'
import { loadQuestionnaire, parseDocTypeFlag } from '../core/doc-questionnaire'
import { searchSupportingFacts } from '../core/doc-supporting-facts'
import type { KbConfig } from './kb-config'
import { createLLMProviderFromConfig } from './kb-config'
import { loadPrompt } from '../prompts/loader'
import type { LLMProvider } from '../core/types'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { ensureOperationalBaseDir, resolveEffectiveBaseDir } from './base-selection'
import { CLI_ERROR_NO_LLM_PROVIDER, formatPrerequisiteError } from './cli-prerequisites'
import { type CmdMode, cmd } from './cmd-ref'

export type DocsGenerateMode = 'start' | 'resume' | 'list' | 'show'

export type DocsGenerateOutputFormat = 'human' | 'json'

export type ParsedDocsGenerateCommand =
  | {
      mode: 'start'
      prompt: string
      base?: string
      type?: DocType
      factLimit?: number
      outputFormat: DocsGenerateOutputFormat
    }
  | {
      mode: 'resume'
      sessionId: string
      base?: string
      factLimit?: number
      action: 'answer' | 'skip' | 'finalize'
      answer?: string
      outputFormat: DocsGenerateOutputFormat
    }
  | { mode: 'list'; base?: string; outputFormat: DocsGenerateOutputFormat }
  | { mode: 'show'; sessionId: string; base?: string; outputFormat: DocsGenerateOutputFormat }

/** True when argv is `kb docs generate ...` and includes `--output json` (for machine-parseable stdout). */
export function isDocsGenerateJsonOutputArgs(argv: string[]): boolean {
  if (argv.length < 2 || argv[0] !== 'docs' || argv[1] !== 'generate') return false
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--output' && argv[i + 1] === 'json') return true
  }
  return false
}

export class DocsGenerateError extends Error {
  exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DocsGenerateError'
    this.exitCode = exitCode
  }
}

export function printDocsGenerateHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs generate', mode)} — guided document draft (questionnaire + LLM draft + fact references)`,
    '',
    'Start a session (classifies doc type unless --type is set):',
    `  ${cmd('docs generate "<prompt>" [--type howto|introduction|reference|decision|runbook] [--limit <n>] [--base <name>]', mode)}`,
    '',
    'Continue:',
    `  ${cmd('docs generate --resume <session-id> --answer "<text>" [--base <name>] [--limit <n>]', mode)}`,
    `  ${cmd('docs generate --resume <session-id> --skip [--base <name>]', mode)}`,
    `  ${cmd('docs generate --resume <session-id> --finalize [--base <name>] [--limit <n>]', mode)}`,
    '',
    'Inspect:',
    `  ${cmd('docs generate --list [--base <name>]', mode)}`,
    `  ${cmd('docs generate --show <session-id> [--base <name>]', mode)}`,
    '',
    '--limit caps supporting facts appended under ## References on finalize (default 20).',
    '',
    `${cmd('--output human|json', mode)}  (default human). Use json for stdout-only structured payloads (no harness banner).`,
  ].join('\n')
}

export function parseDocsGenerateCommand(args: string[]): ParsedDocsGenerateCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new DocsGenerateError(printDocsGenerateHelp(), 0)
  }

  let base: string | undefined
  let typeFlag: DocType | undefined
  let factLimit: number | undefined
  let resumeId: string | undefined
  let showId: string | undefined
  let list = false
  let finalize = false
  let skip = false
  let answer: string | undefined
  let outputFormat: DocsGenerateOutputFormat = 'human'
  const positional: string[] = []

  const readValue = (flag: string, i: number): { value: string; next: number } => {
    const v = args[i + 1]
    if (!v || v.startsWith('--')) {
      throw new DocsGenerateError(`${flag} requires a value\n\n${printDocsGenerateHelp()}`)
    }
    return { value: v, next: i + 1 }
  }

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === '--base') {
      const { value, next } = readValue('--base', i)
      base = value
      i = next
      continue
    }
    if (token === '--type') {
      const { value, next } = readValue('--type', i)
      typeFlag = parseDocTypeFlag(value)
      i = next
      continue
    }
    if (token === '--limit') {
      const { value, next } = readValue('--limit', i)
      const n = Number.parseInt(value, 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new DocsGenerateError('--limit must be a positive integer')
      }
      factLimit = n
      i = next
      continue
    }
    if (token === '--resume') {
      const { value, next } = readValue('--resume', i)
      resumeId = value.trim()
      i = next
      continue
    }
    if (token === '--show') {
      const { value, next } = readValue('--show', i)
      showId = value.trim()
      i = next
      continue
    }
    if (token === '--list') {
      list = true
      continue
    }
    if (token === '--finalize') {
      finalize = true
      continue
    }
    if (token === '--skip') {
      skip = true
      continue
    }
    if (token === '--answer') {
      const { value, next } = readValue('--answer', i)
      answer = value
      i = next
      continue
    }
    if (token === '--output') {
      const { value, next } = readValue('--output', i)
      if (value !== 'human' && value !== 'json') {
        throw new DocsGenerateError(`--output must be one of: human, json\n\n${printDocsGenerateHelp()}`)
      }
      outputFormat = value
      i = next
      continue
    }
    if (token.startsWith('--')) {
      throw new DocsGenerateError(`Unknown option: ${token}\n\n${printDocsGenerateHelp()}`)
    }
    positional.push(token)
  }

  const resumeActions = [finalize, skip, answer !== undefined].filter(Boolean).length

  if (list) {
    if (resumeId || showId || positional.length || resumeActions > 0 || typeFlag !== undefined) {
      throw new DocsGenerateError(`--list does not combine with other generate actions.\n\n${printDocsGenerateHelp()}`)
    }
    return { mode: 'list', base, outputFormat }
  }

  if (showId) {
    if (resumeId || positional.length || resumeActions > 0 || list || typeFlag !== undefined) {
      throw new DocsGenerateError(`--show does not combine with other generate actions.\n\n${printDocsGenerateHelp()}`)
    }
    return { mode: 'show', sessionId: showId, base, outputFormat }
  }

  if (resumeId) {
    if (positional.length || typeFlag !== undefined) {
      throw new DocsGenerateError(`--resume does not accept extra positional args or --type.\n\n${printDocsGenerateHelp()}`)
    }
    if (resumeActions !== 1) {
      throw new DocsGenerateError(
        `With --resume, specify exactly one of: --finalize | --skip | --answer "<text>"\n\n${printDocsGenerateHelp()}`
      )
    }
    if (finalize) {
      return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'finalize', outputFormat }
    }
    if (skip) {
      return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'skip', outputFormat }
    }
    return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'answer', answer, outputFormat }
  }

  if (finalize || skip || answer !== undefined) {
    throw new DocsGenerateError(
      `--finalize, --skip, and --answer require --resume <session-id>.\n\n${printDocsGenerateHelp()}`
    )
  }

  const prompt = positional.join(' ').trim()
  if (!prompt) {
    throw new DocsGenerateError(`docs generate requires a prompt string.\n\n${printDocsGenerateHelp()}`)
  }

  return { mode: 'start', prompt, base, type: typeFlag, factLimit, outputFormat }
}

export interface RunDocsGenerateDeps {
  llm?: LLMProvider
}

export async function runDocsGenerate(
  parsed: ParsedDocsGenerateCommand,
  cwd: string,
  config: KbConfig,
  deps: RunDocsGenerateDeps = {}
): Promise<unknown> {
  const baseDir = parsed.base
    ? await ensureOperationalBaseDir(parsed.base, cwd)
    : (await resolveEffectiveBaseDir(cwd)).baseDir

  switch (parsed.mode) {
    case 'list':
      return { sessions: await listSessionSummaries(baseDir) }
    case 'show': {
      const session = await loadSession(baseDir, parsed.sessionId)
      if (!session) {
        throw new DocsGenerateError(`Session not found: ${parsed.sessionId}`)
      }
      return { session }
    }
    case 'start':
      return runStart(baseDir, parsed, config, deps)
    case 'resume':
      return runResume(baseDir, parsed, config, deps)
    default: {
      const _exhaustive: never = parsed
      return _exhaustive
    }
  }
}

async function runStart(
  baseDir: string,
  parsed: Extract<ParsedDocsGenerateCommand, { mode: 'start' }>,
  config: KbConfig,
  deps: RunDocsGenerateDeps
): Promise<unknown> {
  const docType = parsed.type ?? (await classifyDocType(config, deps, parsed.prompt))
  const items = loadQuestionnaire(docType)
  const session = createSessionRecord({
    prompt: parsed.prompt,
    docType,
    questions: items,
  })
  await saveSession(baseDir, session)
  const idx = firstPendingAnswerIndex(session)
  const q = idx !== null ? session.answers[idx] : undefined
  return {
    status: session.status,
    sessionId: session.id,
    docType: session.docType,
    questionIndex: idx,
    question: q?.question,
    key: q?.key,
  }
}

async function runResume(
  baseDir: string,
  parsed: Extract<ParsedDocsGenerateCommand, { mode: 'resume' }>,
  config: KbConfig,
  deps: RunDocsGenerateDeps
): Promise<unknown> {
  if (parsed.action === 'answer') {
    if (parsed.answer === undefined || !parsed.answer.trim()) {
      throw new DocsGenerateError('--answer requires non-empty text')
    }
    const session = await applyAnswer(baseDir, parsed.sessionId, parsed.answer)
    return formatResumeResponse(session)
  }
  if (parsed.action === 'skip') {
    const session = await applySkip(baseDir, parsed.sessionId)
    return formatResumeResponse(session)
  }
  return runFinalize(baseDir, parsed, config, deps)
}

function formatResumeResponse(session: DocGenerateSession): unknown {
  const idx = firstPendingAnswerIndex(session)
  const q = idx !== null ? session.answers[idx] : undefined
  return {
    status: session.status,
    sessionId: session.id,
    docType: session.docType,
    questionIndex: idx,
    question: q?.question,
    key: q?.key,
  }
}

async function runFinalize(
  baseDir: string,
  parsed: Extract<ParsedDocsGenerateCommand, { mode: 'resume' }>,
  config: KbConfig,
  deps: RunDocsGenerateDeps
): Promise<unknown> {
  const session = await loadSession(baseDir, parsed.sessionId)
  if (!session) {
    throw new DocsGenerateError(`Session not found: ${parsed.sessionId}`)
  }
  if (session.status !== 'ready') {
    throw new DocsGenerateError(
      `Session is not ready to finalize (status=${session.status}). Answer or skip all questions first.`
    )
  }

  const llm = deps.llm ?? createLLMProviderFromConfig(config)
  if (!llm) {
    throw new DocsGenerateError(formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER))
  }

  const draftBody = await draftDocumentBody(llm, session)
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  const factQuery = buildFactSearchQuery(session)
  const facts = searchSupportingFacts(indexer, factQuery, parsed.factLimit ?? 20)
  const fullContent = appendReferencesFooter(draftBody, facts)

  const title = deriveDocumentTitle(session)
  const writer = new SqliteDocumentWriter({ baseDir })
  const result = await writer.writeDocument({
    title,
    content: fullContent,
    type: session.docType,
    tags: ['docs-generate'],
  })

  await markSessionFinalized(baseDir, session.id, {
    draftDocId: result.id,
    supportingFactIds: facts.map(f => f.id),
  })

  return {
    document: result,
    supportingFactCount: facts.length,
    sessionId: session.id,
  }
}

function buildFactSearchQuery(session: DocGenerateSession): string {
  const parts = [session.prompt]
  for (const slot of session.answers) {
    if (slot.answer?.trim()) {
      parts.push(`${slot.key}: ${slot.answer}`)
    }
  }
  return parts.join('\n')
}

async function classifyDocType(
  config: KbConfig,
  deps: RunDocsGenerateDeps,
  prompt: string
): Promise<DocType> {
  const llm = deps.llm ?? createLLMProviderFromConfig(config)
  if (!llm) {
    throw new DocsGenerateError(formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER))
  }
  const systemPrompt = loadPrompt('doc-classify.md')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: `User prompt:\n\n${prompt}` }],
    maxTokens: 32,
    temperature: 0,
  })
  return parseClassifierDocType(res.text)
}

function parseClassifierDocType(text: string): DocType {
  const line = text
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/[`'"]+/g, '')
    .replace(/[.?!]+$/g, '')
    .toLowerCase()
  if (isDocType(line)) return line
  const first = line.split(/\s+/)[0] ?? ''
  if (isDocType(first)) return first
  for (const t of DOC_TYPES) {
    if (line.includes(t)) return t
  }
  return 'reference'
}

async function draftDocumentBody(llm: LLMProvider, session: DocGenerateSession): Promise<string> {
  const systemPrompt = loadPrompt('doc-draft-system.md')
  const lines = [
    `Document type: ${session.docType}`,
    '',
    'Original user prompt:',
    session.prompt,
    '',
    'Structured answers:',
    ...session.answers.map(slot => {
      const status = slot.skipped ? '(skipped)' : ''
      const body = slot.skipped ? '' : slot.answer ?? ''
      return `- **${slot.key}** ${status}: ${body}`.trimEnd()
    }),
  ]
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
    maxTokens: 8192,
    temperature: 0.35,
  })
  return res.text.trim()
}
