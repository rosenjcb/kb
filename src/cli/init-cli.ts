/**
 * kb init — 5-cycle knowledge base bootstrap command.
 *
 * Cycle 1 (read-inputs):  Discover README/CLAUDE.md in working dir,
 *                          ask user up to 10 targeted questions via stdin.
 * Cycles 2-4 (pass1-3):  LLM synthesis + refinement passes.
 * Cycle 5 (write):        Upsert all candidate documents to SQLite.
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import readline from 'node:readline'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'
import type { LLMProvider } from '../core/types'
import { resolveBaseToDir } from './base-selection'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import type { WriteDocumentInput } from '../tools/document-writer'

// ─── Types ───────────────────────────────────────────────────────

export type InitCycle = 'read-inputs' | 'pass1' | 'pass2' | 'pass3' | 'write'

export interface InitOptions {
  base: string
  apply: boolean
  dryRun: boolean
  nonInteractive: boolean
  stopAfter?: InitCycle
  resumeFrom?: string
  checkpointFile?: string
  cwd?: string
}

export interface InitResult {
  status: 'accepted' | 'paused'
  base: string
  apply: boolean
  completedCycles: InitCycle[]
  writtenDocIds?: string[]
  checkpointFile?: string
  resumedFrom?: string
}

interface CandidateDoc {
  id?: string
  title: string
  content: string
  type?: WriteDocumentInput['type']
  tags?: string[]
}

interface InitContext {
  sourceFiles: Record<string, string>   // filename → content
  userAnswers: Array<{ question: string; answer: string }>
}

interface InitCheckpoint {
  version: 1
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
}

// ─── Progress Reporter (same style as publish-cli) ───────────────

class InitProgressReporter {
  private completed = 0
  constructor(private total: number) {}

  start(label: string, detail?: string) { this.render(label, detail) }
  finish(label: string, detail?: string) { this.completed++; this.render(label, detail) }
  update(label: string, detail?: string) { this.render(label, detail) }

  private render(label: string, detail?: string) {
    const width = 24
    const filled = Math.round((this.completed / Math.max(this.total, 1)) * width)
    const bar = `${'='.repeat(filled)}${'-'.repeat(Math.max(width - filled, 0))}`
    const suffix = detail ? ` ${detail}` : ''
    process.stderr.write(`[init] [${bar}] ${this.completed}/${this.total} ${label}${suffix}\n`)
  }
}

// ─── CLI Parsing ─────────────────────────────────────────────────

export function parseInitCommand(args: string[]): InitOptions {
  const base = readOption(args, '--base')
  if (!base) throw new Error('kb init requires --base <name>')

  const hasApply = readFlag(args, '--apply')
  const hasDryRun = readFlag(args, '--dry-run')
  if (hasApply && hasDryRun) throw new Error('Use either --apply or --dry-run, not both')

  const stopAfter = readOption(args, '--stop-after') as InitCycle | undefined
  const validCycles: InitCycle[] = ['read-inputs', 'pass1', 'pass2', 'pass3', 'write']
  if (stopAfter && !validCycles.includes(stopAfter)) {
    throw new Error(`Invalid --stop-after. Use: ${validCycles.join('|')}`)
  }

  return {
    base,
    apply: hasApply,
    dryRun: hasDryRun || !hasApply,
    nonInteractive: readFlag(args, '--non-interactive'),
    stopAfter,
    resumeFrom: readOption(args, '--resume-from'),
    checkpointFile: readOption(args, '--checkpoint-file'),
  }
}

// ─── Main Entry Point ────────────────────────────────────────────

export async function runKbInit(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd()
  const baseDir = resolveBaseToDir(options.base, cwd)
  const checkpointFile = resolveCheckpointPath(options, cwd)
  const resumedCheckpoint = await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(5)
  const provider = resolveProvider()

  let checkpoint: InitCheckpoint = resumedCheckpoint ?? {
    version: 1,
    updatedAt: dayjs().toISOString(),
    baseName: options.base,
    workingDir: cwd,
    completedCycles: [],
  }

  if (resumedCheckpoint) {
    progress.update('resumed', path.basename(checkpointFile))
  }

  const persist = async (updates: Partial<InitCheckpoint>) => {
    checkpoint = {
      ...checkpoint,
      ...updates,
      updatedAt: dayjs().toISOString(),
      completedCycles: dedup([...(checkpoint.completedCycles ?? []), ...(updates.completedCycles ?? [])]),
    }
    await writeCheckpoint(checkpointFile, checkpoint)
  }

  let paused = false

  try {
    // ── Cycle 1: read-inputs ──────────────────────────────────────
    let context = checkpoint.context
    if (!checkpoint.completedCycles.includes('read-inputs')) {
      progress.start('read-inputs', 'discovering docs…')
      context = await runReadInputsCycle(cwd, options.nonInteractive)
      await persist({ context, completedCycles: ['read-inputs'] })
      progress.finish('read-inputs', `${Object.keys(context.sourceFiles).length} files, ${context.userAnswers.length} answers`)
      if (options.stopAfter === 'read-inputs') throw new InitPausedError('read-inputs')
    } else {
      progress.finish('read-inputs', 'reused from checkpoint')
    }

    if (!context) throw new Error('read-inputs context missing')

    // ── Cycle 2: pass1 ───────────────────────────────────────────
    let candidateDocs = checkpoint.candidateDocs
    if (!checkpoint.completedCycles.includes('pass1')) {
      progress.start('pass1', 'synthesising facts…')
      if (!provider) throw new Error('No LLM provider available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.')
      candidateDocs = await runSynthesisPass(provider, context, options.base)
      await persist({ candidateDocs, completedCycles: ['pass1'] })
      progress.finish('pass1', `${candidateDocs.length} candidate docs`)
      if (options.stopAfter === 'pass1') throw new InitPausedError('pass1')
    } else {
      progress.finish('pass1', 'reused from checkpoint')
    }

    if (!candidateDocs) throw new Error('pass1 candidateDocs missing')

    // ── Cycle 3: pass2 ───────────────────────────────────────────
    if (!checkpoint.completedCycles.includes('pass2')) {
      progress.start('pass2', 'refining docs…')
      if (!provider) throw new Error('No LLM provider available.')
      candidateDocs = await runRefinementPass(provider, context, candidateDocs)
      await persist({ candidateDocs, completedCycles: ['pass2'] })
      progress.finish('pass2', `${candidateDocs.length} docs after refinement`)
      if (options.stopAfter === 'pass2') throw new InitPausedError('pass2')
    } else {
      progress.finish('pass2', 'reused from checkpoint')
    }

    // ── Cycle 4: pass3 ───────────────────────────────────────────
    if (!checkpoint.completedCycles.includes('pass3')) {
      progress.start('pass3', 'quality pass…')
      if (!provider) throw new Error('No LLM provider available.')
      candidateDocs = await runQualityPass(provider, candidateDocs)
      await persist({ candidateDocs, completedCycles: ['pass3'] })
      progress.finish('pass3', `${candidateDocs.length} docs finalised`)
      if (options.stopAfter === 'pass3') throw new InitPausedError('pass3')
    } else {
      progress.finish('pass3', 'reused from checkpoint')
    }

    // ── Cycle 5: write ───────────────────────────────────────────
    if (!checkpoint.completedCycles.includes('write')) {
      progress.start('write', options.dryRun ? '(dry-run)' : baseDir)
      const writtenDocIds = options.dryRun
        ? candidateDocs.map(d => slugify(d.title))
        : await writeDocs(candidateDocs, baseDir, options.base)
      await persist({ completedCycles: ['write'] })
      progress.finish('write', `${writtenDocIds.length} docs written`)

      return {
        status: 'accepted',
        base: options.base,
        apply: options.apply,
        completedCycles: checkpoint.completedCycles,
        writtenDocIds,
        checkpointFile,
        resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
      }
    }

    progress.finish('write', 'reused from checkpoint')

  } catch (err) {
    if (err instanceof InitPausedError) {
      paused = true
    } else {
      throw err
    }
  }

  return {
    status: paused ? 'paused' : 'accepted',
    base: options.base,
    apply: options.apply,
    completedCycles: checkpoint.completedCycles,
    checkpointFile,
    resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
  }
}

// ─── Cycle Implementations ────────────────────────────────────────

const SOURCE_FILE_CANDIDATES = [
  'README.md', 'README.txt', 'readme.md',
  'CLAUDE.md', 'AGENTS.md',
  'CONTRIBUTING.md', 'ARCHITECTURE.md',
  'docs/README.md', 'docs/overview.md', 'docs/architecture.md',
]

const MAX_SOURCE_SIZE = 20_000 // chars per file
const MAX_QUESTIONS = 10

async function runReadInputsCycle(
  cwd: string,
  nonInteractive: boolean,
): Promise<InitContext> {
  // 1. Collect source files
  const sourceFiles: Record<string, string> = {}
  for (const candidate of SOURCE_FILE_CANDIDATES) {
    const full = path.join(cwd, candidate)
    if (existsSync(full)) {
      const content = await readFile(full, 'utf8')
      sourceFiles[candidate] = content.slice(0, MAX_SOURCE_SIZE)
    }
  }

  // Also scan for any top-level .md files we might have missed
  try {
    const topLevel = await readdir(cwd)
    for (const file of topLevel) {
      if (file.endsWith('.md') && !sourceFiles[file] && Object.keys(sourceFiles).length < 8) {
        const content = await readFile(path.join(cwd, file), 'utf8')
        sourceFiles[file] = content.slice(0, MAX_SOURCE_SIZE)
      }
    }
  } catch { /* ignore */ }

  // 2. Generate + ask questions
  const userAnswers: Array<{ question: string; answer: string }> = []

  if (!nonInteractive && Object.keys(sourceFiles).length > 0) {
    const questions = generateInitialQuestions(sourceFiles)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string): Promise<string> =>
      new Promise(resolve => rl.question(q, answer => resolve(answer.trim())))

    process.stdout.write('\n[kb init] A few quick questions to fill in gaps (press Enter to skip):\n\n')

    for (const question of questions.slice(0, MAX_QUESTIONS)) {
      const answer = await ask(`  > ${question}\n    `)
      if (answer) userAnswers.push({ question, answer })
    }

    rl.close()
    process.stdout.write('\n')
  } else if (!nonInteractive && Object.keys(sourceFiles).length === 0) {
    // No source files found — ask a few foundational questions
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string): Promise<string> =>
      new Promise(resolve => rl.question(q, answer => resolve(answer.trim())))

    const fallbackQuestions = [
      'What is this project? (1-2 sentences)',
      'What are the main commands or entry points?',
      'What problem does it solve?',
      'What are the key architectural components?',
      'Who is the intended user?',
    ]

    process.stdout.write('\n[kb init] No README found. Answering these questions will seed your KB:\n\n')
    for (const q of fallbackQuestions) {
      const answer = await ask(`  > ${q}\n    `)
      if (answer) userAnswers.push({ question: q, answer })
    }

    rl.close()
    process.stdout.write('\n')
  }

  return { sourceFiles, userAnswers }
}

function generateInitialQuestions(sourceFiles: Record<string, string>): string[] {
  const content = Object.values(sourceFiles).join('\n').toLowerCase()

  const questions: string[] = []

  if (!content.includes('install') && !content.includes('setup')) {
    questions.push('How do you install or set up this project?')
  }
  if (!content.includes('usage') && !content.includes('example')) {
    questions.push('What are the most common usage examples or commands?')
  }
  if (!content.includes('architecture') && !content.includes('design')) {
    questions.push('What is the high-level architecture? (key components and how they relate)')
  }
  if (!content.includes('config') && !content.includes('configuration')) {
    questions.push('How is the project configured? (env vars, config files, etc.)')
  }
  if (!content.includes('test')) {
    questions.push('How do you run tests?')
  }
  if (!content.includes('deploy') && !content.includes('release')) {
    questions.push('How is this project deployed or released?')
  }
  questions.push('Are there any important decisions or constraints not obvious from the README?')
  questions.push('What are the most common gotchas or things new contributors get wrong?')

  return questions
}

async function runSynthesisPass(
  provider: LLMProvider,
  context: InitContext,
  baseName: string,
): Promise<CandidateDoc[]> {
  const sourceSection = Object.entries(context.sourceFiles)
    .map(([file, content]) => `### ${file}\n${content}`)
    .join('\n\n---\n\n')

  const qaSection = context.userAnswers.length > 0
    ? context.userAnswers.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join('\n\n')
    : '(No Q&A collected)'

  const systemPrompt = `You are a knowledge base architect. Your job is to extract structured, retrieval-ready fact documents from project documentation.`

  const userPrompt = `You are initialising a knowledge base for the project base "${baseName}".

Below is the source documentation and user Q&A answers. Your task is to produce a set of structured fact documents that will be stored in the KB for future AI-assisted retrieval.

## Source Files
${sourceSection}

## User Q&A
${qaSection}

## Instructions
Produce 5-15 focused documents. Each document should be atomic and retrieval-optimised. Avoid duplicating facts.

Return a JSON array with this shape:
[
  {
    "title": "string (concise noun phrase)",
    "type": "architecture" | "decision" | "reference" | "runbook" | "checklist",
    "tags": ["tag1", "tag2"],
    "content": "Markdown body. Start with a brief 1-sentence summary, then bullet facts or short paragraphs."
  }
]

Required document categories:
- 1 overall project overview (type: architecture)
- 1 CLI/usage reference (type: reference) if applicable
- 1 configuration reference (type: reference) if applicable
- Fact documents for key decisions, architecture components, policies

  Return ONLY the JSON array, no prose.`

  const response = await provider.call({
    messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
    maxTokens: 4000,
    temperature: 0.2,
  })

  return parseDocArray(response.text) ?? fallbackDocs(context, baseName)
}

async function runRefinementPass(
  provider: LLMProvider,
  context: InitContext,
  docs: CandidateDoc[],
): Promise<CandidateDoc[]> {
  const docsJson = JSON.stringify(docs, null, 2)

  const prompt = `You are refining a set of KB documents for quality and completeness.

## Current documents
${docsJson}

## Additional user context
${context.userAnswers.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join('\n\n') || '(none)'}

## Instructions
1. Merge documents that clearly cover the same topic (avoid duplicates).
2. Split any document that covers 2+ unrelated topics.
3. Ensure each document has a concise, specific title.
4. Fill in any obvious gaps — if an important topic is missing based on the user answers, add a document for it.
5. Remove content that is vague, redundant, or not factual.

Return the refined JSON array in the same shape. Return ONLY the JSON array.`

  const response = await provider.call({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4000,
    temperature: 0.1,
  })

  return parseDocArray(response.text) ?? docs
}

async function runQualityPass(
  provider: LLMProvider,
  docs: CandidateDoc[],
): Promise<CandidateDoc[]> {
  const docsJson = JSON.stringify(docs, null, 2)

  const prompt = `You are doing a final quality pass on KB documents before they are written to storage.

## Documents
${docsJson}

## Checks to apply
1. Every document must have a non-empty title and content.
2. Content should start with a 1-sentence summary.
3. Tags should be lowercase, hyphenated slugs relevant to the content.
4. Type must be one of: architecture, decision, reference, runbook, checklist.
5. Remove any document with fewer than 20 words of content.
6. Ensure titles are unique.

Return the final JSON array. Return ONLY the JSON array.`

  const response = await provider.call({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4000,
    temperature: 0.0,
  })

  return parseDocArray(response.text) ?? docs
}

async function writeDocs(
  docs: CandidateDoc[],
  baseDir: string,
  base: string,
): Promise<string[]> {
  const writer = new SqliteDocumentWriter({ baseDir, base })
  const writtenIds: string[] = []

  for (const doc of docs) {
    const result = await writer.writeDocument({
      title: doc.title,
      content: doc.content,
      type: doc.type,
      tags: doc.tags,
      documentId: doc.id ?? slugify(doc.title),
      overwrite: true,
    })
    writtenIds.push(result.id)
  }

  return writtenIds
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseDocArray(text: string): CandidateDoc[] | null {
  // Extract JSON array from LLM response (may have surrounding prose)
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as unknown[]
    if (!Array.isArray(parsed)) return null
    const docs = parsed.filter(
      (item): item is CandidateDoc =>
        typeof item === 'object' && item !== null &&
        typeof (item as CandidateDoc).title === 'string' &&
        typeof (item as CandidateDoc).content === 'string',
    )
    return docs.length > 0 ? docs : null
  } catch {
    return null
  }
}

function fallbackDocs(context: InitContext, baseName: string): CandidateDoc[] {
  const content = Object.entries(context.sourceFiles)
    .map(([f, c]) => `## ${f}\n${c}`)
    .join('\n\n')

  const qaContent = context.userAnswers
    .map(({ question, answer }) => `- **${question}** ${answer}`)
    .join('\n')

  return [{
    title: `${baseName} project overview`,
    type: 'architecture',
    tags: ['overview', baseName],
    content: `# ${baseName} project overview\n\nAuto-generated from project documentation.\n\n${content}\n\n${qaContent}`,
  }]
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document'
}

function resolveProvider(): LLMProvider | undefined {
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      return createProvider({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY })
    }
    if (process.env.OPENAI_API_KEY) {
      return createProvider({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY })
    }
    if (process.env.GEMINI_API_KEY) {
      return createProvider({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY })
    }
    return createProvider({ provider: 'ollama', endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434' })
  } catch {
    return undefined
  }
}

function resolveCheckpointPath(options: InitOptions, cwd: string): string {
  if (options.resumeFrom || options.checkpointFile) {
    return path.resolve(cwd, (options.resumeFrom ?? options.checkpointFile)!)
  }
  return path.join(cwd, '.tmp', 'kb-init', `${slugify(options.base)}-latest.checkpoint.json`)
}

async function readCheckpoint(filePath: string): Promise<InitCheckpoint | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as InitCheckpoint
    return parsed?.version === 1 ? parsed : undefined
  } catch {
    return undefined
  }
}

async function writeCheckpoint(filePath: string, checkpoint: InitCheckpoint): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

function dedup<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined
}

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

class InitPausedError extends Error {
  constructor(readonly cycle: InitCycle) {
    super(`Init paused after ${cycle}`)
  }
}
