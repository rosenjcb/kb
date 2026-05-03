import type { DocType } from '../core/doc-taxonomy'
import {
  applyAnswer,
  applySkip,
  firstPendingAnswerIndex,
  listSessionSummaries,
  loadSession,
  type DocGenerateSession,
} from '../core/doc-generate-session'
import {
  acceptDraft,
  type DocGenerateOrchestratorDeps,
  produceInitialDraft,
  produceRevisedDraft,
  startGenerationSession,
} from '../core/doc-generate-orchestrator'
import { parseDocTypeFlag } from '../core/doc-questionnaire'
import { colorizeUnifiedDiff } from '../core/git-diff-preview'
import type { KbConfig } from './kb-config'
import { createLLMProviderFromConfig } from './kb-config'
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
      action: 'answer' | 'skip' | 'finalize' | 'accept' | 'reject'
      answer?: string
      rejectFeedback?: string
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
    `  ${cmd('docs generate --resume <session-id> --accept [--base <name>]', mode)}`,
    `  ${cmd('docs generate --resume <session-id> --reject "<feedback>" [--base <name>] [--limit <n>]', mode)}`,
    '',
    'Inspect:',
    `  ${cmd('docs generate --list [--base <name>]', mode)}`,
    `  ${cmd('docs generate --show <session-id> [--base <name>]', mode)}`,
    '',
    '--finalize drafts the document (awaiting review). --accept writes it to the KB. --reject revises the draft from your feedback (git-style diff between revisions).',
    '--limit caps supporting facts appended under ## References on finalize / reject (default 20).',
    '',
    'Architecture: facts-first KB (query, docgen, ingest). See src/core/facts-architecture.md.',
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
  let accept = false
  let rejectFeedback: string | undefined
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
    if (token === '--accept') {
      accept = true
      continue
    }
    if (token === '--reject') {
      const { value, next } = readValue('--reject', i)
      rejectFeedback = value
      i = next
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

  const resumeActions = [finalize, skip, answer !== undefined, accept, rejectFeedback !== undefined].filter(
    Boolean
  ).length

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
        `With --resume, specify exactly one of: --finalize | --skip | --answer "<text>" | --accept | --reject "<feedback>"\n\n${printDocsGenerateHelp()}`
      )
    }
    if (finalize) {
      return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'finalize', outputFormat }
    }
    if (skip) {
      return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'skip', outputFormat }
    }
    if (accept) {
      return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'accept', outputFormat }
    }
    if (rejectFeedback !== undefined) {
      if (!rejectFeedback.trim()) {
        throw new DocsGenerateError(`--reject requires non-empty feedback\n\n${printDocsGenerateHelp()}`)
      }
      return {
        mode: 'resume',
        sessionId: resumeId,
        base,
        factLimit,
        action: 'reject',
        rejectFeedback: rejectFeedback.trim(),
        outputFormat,
      }
    }
    return { mode: 'resume', sessionId: resumeId, base, factLimit, action: 'answer', answer, outputFormat }
  }

  if (finalize || skip || answer !== undefined || accept || rejectFeedback !== undefined) {
    throw new DocsGenerateError(
      `--finalize, --skip, --answer, --accept, and --reject require --resume <session-id>.\n\n${printDocsGenerateHelp()}`
    )
  }

  const prompt = positional.join(' ').trim()
  if (!prompt) {
    throw new DocsGenerateError(`docs generate requires a prompt string.\n\n${printDocsGenerateHelp()}`)
  }

  return { mode: 'start', prompt, base, type: typeFlag, factLimit, outputFormat }
}

export type RunDocsGenerateDeps = DocGenerateOrchestratorDeps

/** Human-readable lines for stdout (no JSON). */
export function formatDocsGenerateHumanOutput(generated: unknown): string {
  const g = generated as Record<string, unknown>
  const lines: string[] = []

  if (typeof g.status === 'string') lines.push(`Status: ${g.status}`)
  if (typeof g.sessionId === 'string') lines.push(`Session: ${g.sessionId}`)
  if (typeof g.revision === 'number') lines.push(`Revision: ${g.revision}`)
  if (typeof g.supportingFactCount === 'number') {
    lines.push(`Supporting facts: ${g.supportingFactCount}`)
  }
  if (Array.isArray(g.nextActions)) {
    lines.push(`Next: ${(g.nextActions as string[]).join('  |  ')}`)
  }
  if (typeof g.diff === 'string' && g.diff.trim()) {
    lines.push('')
    lines.push('--- diff (previous → current) ---')
    lines.push(colorizeUnifiedDiff(g.diff, { color: process.stdout.isTTY }))
  }
  if (typeof g.content === 'string' && g.content.trim() && !g.diff) {
    lines.push('')
    lines.push('--- draft body ---')
    lines.push(g.content)
  }
  if (typeof g.contentWithFooter === 'string' && g.contentWithFooter.trim() && !g.content) {
    lines.push('')
    lines.push('--- draft with references ---')
    lines.push(g.contentWithFooter)
  }
  if (g.document && typeof g.document === 'object') {
    const doc = g.document as { id?: string; title?: string }
    lines.push('')
    lines.push(`Document id: ${doc.id ?? '(unknown)'}`)
    if (doc.title) lines.push(`Title: ${doc.title}`)
  }
  if (typeof g.question === 'string') {
    lines.push(`Question: ${g.question}`)
  }
  if (typeof g.key === 'string') {
    lines.push(`Key: ${g.key}`)
  }

  return lines.join('\n').trimEnd()
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
  return startGenerationSession({
    baseDir,
    prompt: parsed.prompt,
    type: parsed.type,
    config,
    deps,
  })
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
  if (parsed.action === 'accept') {
    return acceptDraft({ baseDir, sessionId: parsed.sessionId, deps })
  }
  if (parsed.action === 'reject') {
    const llm = deps.llm ?? createLLMProviderFromConfig(config)
    if (!llm) {
      throw new DocsGenerateError(formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER))
    }
    return produceRevisedDraft({
      baseDir,
      sessionId: parsed.sessionId,
      llm,
      feedback: parsed.rejectFeedback ?? '',
      factLimit: parsed.factLimit,
    })
  }
  return runFinalizeDraft(baseDir, parsed, config, deps)
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

async function runFinalizeDraft(
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

  const out = await produceInitialDraft({
    baseDir,
    sessionId: parsed.sessionId,
    llm,
    factLimit: parsed.factLimit,
  })
  return {
    ...out,
    docType: session.docType,
  }
}
