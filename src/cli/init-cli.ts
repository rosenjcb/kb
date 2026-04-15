/**
 * kb init — knowledge base bootstrap command.
 *
 * Cycle 1 (read-inputs):  Discover README/CLAUDE.md in working dir,
 *                          ask an initial interview round via stdin.
 * Cycles 2-4 (pass1-3):  Draft docs, assess topic coverage, ask follow-ups,
 *                          refine docs, then run a final quality pass.
 * Cycle 5 (write):       Upsert all candidate documents to SQLite.
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import readline from 'node:readline'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'
import type { LLMProvider } from '../core/types'
import { resolveBaseToDir } from './base-selection'
import {
  assessTopicCoverage,
  buildTopicCoverageGaps,
  getTopicDefinition,
  inferTopicFromQuestion,
  INIT_TOPIC_DEFINITIONS,
  markUnaskedTopicsAsInferred,
  summariseCoverage,
} from './init-topic-coverage'
import type { WriteDocumentInput } from '../tools/document-writer'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'

export type InitCycle = 'read-inputs' | 'pass1' | 'pass2' | 'pass3' | 'write'
export type InitTopic =
  | 'project-overview'
  | 'install-setup'
  | 'core-workflows'
  | 'architecture'
  | 'configuration'
  | 'testing'
  | 'deployment-release'
  | 'constraints-gotchas'

export type TopicCoverageStatus = 'sufficient' | 'needs-follow-up' | 'inferred-only' | 'unresolved'

export interface InitOptions {
  base: string
  apply: boolean
  dryRun: boolean
  nonInteractive: boolean
  detach?: boolean
  resume?: boolean
  stopAfter?: InitCycle
  resumeFrom?: string
  checkpointFile?: string
  cwd?: string
  provider?: LLMProvider
  questionIO?: InitQuestionIO
}

export interface InitResult {
  status: 'accepted' | 'paused'
  base: string
  apply: boolean
  completedCycles: InitCycle[]
  writtenDocIds?: string[]
  checkpointFile?: string
  resumedFrom?: string
  coverageSummary?: InitCoverageSummary
}

export interface InitUserAnswer {
  question: string
  answer: string
  topic?: InitTopic
}

export interface InitContext {
  sourceFiles: Record<string, string>
  userAnswers: InitUserAnswer[]
}

export interface InitInterviewQuestion {
  id: string
  round: number
  topic: InitTopic
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  question: string
  answer?: string
  askedAt?: string
  answeredAt?: string
}

export interface InitInterviewRound {
  round: number
  questions: InitInterviewQuestion[]
}

export interface TopicCoverageAssessment {
  topic: InitTopic
  confidence: 'high' | 'medium' | 'low'
  status: TopicCoverageStatus
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  keyEvidence: string[]
  missingFields: string[]
  enoughContext: boolean
  stopReason?:
    | 'enough-grounded-evidence'
    | 'user-confirmed'
    | 'question-budget-exhausted'
    | 'non-interactive-mode'
    | 'still-ambiguous'
}

export interface InitCoverageSummary {
  coveredTopics: InitTopic[]
  inferredTopics: InitTopic[]
  unresolvedTopics: InitTopic[]
}

interface CandidateDoc {
  id?: string
  title: string
  content: string
  type?: WriteDocumentInput['type']
  tags?: string[]
}

interface InitCheckpointV1 {
  version: 1
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
}

export interface InitCheckpoint {
  version: 2
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
  interviewRounds?: InitInterviewRound[]
  topicCoverage?: TopicCoverageAssessment[]
  finalCoverageSummary?: InitCoverageSummary
}

type StoredInitCheckpoint = InitCheckpointV1 | InitCheckpoint

export interface InitQuestionIO {
  write?: (message: string) => void
  askQuestion: (question: string) => Promise<string>
  close?: () => Promise<void> | void
}

class InitProgressReporter {
  private completed = 0

  constructor(private total: number) {}

  start(label: string, detail?: string) {
    this.render(label, detail)
  }

  finish(label: string, detail?: string) {
    this.completed += 1
    this.render(label, detail)
  }

  update(label: string, detail?: string) {
    this.render(label, detail)
  }

  private render(label: string, detail?: string) {
    const width = 24
    const filled = Math.round((this.completed / Math.max(this.total, 1)) * width)
    const bar = `${'='.repeat(filled)}${'-'.repeat(Math.max(width - filled, 0))}`
    const suffix = detail ? ` ${detail}` : ''
    process.stderr.write(`[init] [${bar}] ${this.completed}/${this.total} ${label}${suffix}\n`)
  }
}

const SOURCE_FILE_CANDIDATES = [
  'README.md', 'README.txt', 'readme.md',
  'CLAUDE.md', 'AGENTS.md',
  'CONTRIBUTING.md', 'ARCHITECTURE.md',
  'docs/README.md', 'docs/overview.md', 'docs/architecture.md',
]

const MAX_SOURCE_SIZE = 20_000
const MAX_TOTAL_QUESTIONS = 10
const MAX_FOLLOW_UP_QUESTIONS = 4

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
    detach: readFlag(args, '--detach'),
    resume: readFlag(args, '--resume'),
    stopAfter,
    resumeFrom: readOption(args, '--resume-from'),
    checkpointFile: readOption(args, '--checkpoint-file'),
  }
}

export async function runKbInit(options: InitOptions): Promise<InitResult> {
  // When using real readline (no injected questionIO) and stdin is not a TTY
  // (e.g. CI, background process, piped input), force non-interactive mode so
  // readline doesn't throw "readline was closed".
  if (!options.questionIO && !process.stdin.isTTY) {
    options = { ...options, nonInteractive: true }
  }

  const cwd = options.cwd ?? process.cwd()
  const baseDir = resolveBaseToDir(options.base, cwd)
  const checkpointFile = resolveCheckpointPath(options, cwd)
  const resumedCheckpoint = await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(5)
  const provider = options.provider ?? resolveProvider()
  const questionIO = options.questionIO ?? createReadlineQuestionIO()

  let checkpoint: InitCheckpoint = resumedCheckpoint ?? {
    version: 2,
    updatedAt: dayjs().toISOString(),
    baseName: options.base,
    workingDir: cwd,
    completedCycles: [],
    interviewRounds: [],
    topicCoverage: [],
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
      interviewRounds: updates.interviewRounds ?? checkpoint.interviewRounds ?? [],
      topicCoverage: updates.topicCoverage ?? checkpoint.topicCoverage ?? [],
      finalCoverageSummary: updates.finalCoverageSummary ?? checkpoint.finalCoverageSummary,
    }
    await writeCheckpoint(checkpointFile, checkpoint)
  }

  let paused = false

  try {
    let context = checkpoint.context
    let candidateDocs = checkpoint.candidateDocs
    let interviewRounds = checkpoint.interviewRounds ?? []
    let topicCoverage = checkpoint.topicCoverage ?? []

    if (!checkpoint.completedCycles.includes('read-inputs')) {
      progress.start('read-inputs', 'discovering docs…')
      if (context && hasPendingQuestions(interviewRounds)) {
        const pendingRound = latestPendingRound(interviewRounds)
        if (!pendingRound) throw new Error('Pending read-inputs interview round missing')
        const answeredRound = await answerPendingQuestions({
          heading: '\n[kb init] Resuming pending questions:\n\n',
          round: pendingRound,
          questionIO,
        })
        interviewRounds = replaceInterviewRound(interviewRounds, answeredRound)
        context = mergeInterviewAnswersIntoContext(context, answeredRound)
        topicCoverage = assessTopicCoverage(context, undefined, false)
      } else {
        const readResult = await runReadInputsCycle({
          cwd,
          nonInteractive: options.nonInteractive,
          detach: options.detach,
          questionIO,
          startingRound: interviewRounds.length + 1,
          maxQuestions: remainingQuestionBudget(interviewRounds),
        })
        context = readResult.context
        interviewRounds = appendRoundIfPresent(interviewRounds, readResult.interviewRound)
        topicCoverage = readResult.topicCoverage
        if (readResult.paused) {
          await persist({
            context,
            interviewRounds,
            topicCoverage,
          })
          throw new InitPausedError('read-inputs')
        }
      }
      await persist({
        context,
        interviewRounds,
        topicCoverage,
        completedCycles: ['read-inputs'],
      })
      progress.finish(
        'read-inputs',
        `${Object.keys(context.sourceFiles).length} files, ${context.userAnswers.length} answers`,
      )
      if (options.stopAfter === 'read-inputs') throw new InitPausedError('read-inputs')
    } else {
      progress.finish('read-inputs', 'reused from checkpoint')
    }

    if (!context) throw new Error('read-inputs context missing')

    if (!checkpoint.completedCycles.includes('pass1')) {
      progress.start('pass1', 'drafting docs + coverage…')
      if (!provider) {
        throw new Error('No LLM provider available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.')
      }
      candidateDocs = await runSynthesisPass(provider, context, options.base)
      topicCoverage = assessTopicCoverage(context, candidateDocs, options.nonInteractive)
      await persist({
        candidateDocs,
        topicCoverage,
        completedCycles: ['pass1'],
      })
      progress.finish('pass1', `${candidateDocs.length} candidate docs`)
      if (options.stopAfter === 'pass1') throw new InitPausedError('pass1')
    } else {
      progress.finish('pass1', 'reused from checkpoint')
    }

    if (!candidateDocs) throw new Error('pass1 candidateDocs missing')

    if (!checkpoint.completedCycles.includes('pass2')) {
      progress.start('pass2', 'follow-up + refining docs…')

      if (!options.nonInteractive) {
        const pendingFollowUp = latestPendingRound(interviewRounds)
        if (pendingFollowUp && checkpoint.completedCycles.includes('pass1')) {
          const answeredRound = await answerPendingQuestions({
            heading: '\n[kb init] Resuming pending follow-up questions:\n\n',
            round: pendingFollowUp,
            questionIO,
          })
          interviewRounds = replaceInterviewRound(interviewRounds, answeredRound)
          context = mergeInterviewAnswersIntoContext(context, answeredRound)
        } else {
          const followUpQuestions = planFollowUpQuestions({
            topicCoverage,
            existingRounds: interviewRounds,
            round: interviewRounds.length + 1,
            maxQuestions: Math.min(remainingQuestionBudget(interviewRounds), MAX_FOLLOW_UP_QUESTIONS),
          })

          if (followUpQuestions.length > 0) {
            if (options.detach) {
              interviewRounds = appendRoundIfPresent(interviewRounds, {
                round: followUpQuestions[0].round,
                questions: followUpQuestions,
              })
              await persist({
                context,
                candidateDocs,
                interviewRounds,
                topicCoverage,
              })
              throw new InitPausedError('pass2')
            }

            const followUpRound = await askQuestions({
              heading: '\n[kb init] Follow-up questions for weak topics:\n\n',
              questions: followUpQuestions,
              questionIO,
            })
            interviewRounds = appendRoundIfPresent(interviewRounds, followUpRound)
            context = mergeInterviewAnswersIntoContext(context, followUpRound)
          }
        }
      } else {
        topicCoverage = markUnaskedTopicsAsInferred(topicCoverage, 'non-interactive-mode')
      }

      if (!provider) throw new Error('No LLM provider available.')
      candidateDocs = await runRefinementPass(provider, context, candidateDocs)
      topicCoverage = assessTopicCoverage(context, candidateDocs, options.nonInteractive)
      await persist({
        context,
        candidateDocs,
        interviewRounds,
        topicCoverage,
        completedCycles: ['pass2'],
      })
      progress.finish('pass2', `${candidateDocs.length} docs after refinement`)
      if (options.stopAfter === 'pass2') throw new InitPausedError('pass2')
    } else {
      progress.finish('pass2', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('pass3')) {
      progress.start('pass3', 'quality pass…')
      if (!provider) throw new Error('No LLM provider available.')
      candidateDocs = await runQualityPass(provider, candidateDocs)
      topicCoverage = assessTopicCoverage(context, candidateDocs, options.nonInteractive)
      const finalCoverageSummary = summariseCoverage(topicCoverage)
      await persist({
        candidateDocs,
        topicCoverage,
        finalCoverageSummary,
        completedCycles: ['pass3'],
      })
      progress.finish('pass3', `${candidateDocs.length} docs finalised`)
      if (options.stopAfter === 'pass3') throw new InitPausedError('pass3')
    } else {
      progress.finish('pass3', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('write')) {
      progress.start('write', options.dryRun ? '(dry-run)' : baseDir)
      const writtenDocIds = options.dryRun
        ? candidateDocs.map(doc => slugify(doc.title))
        : await writeDocs(candidateDocs, baseDir, options.base)
      const finalCoverageSummary = checkpoint.finalCoverageSummary ?? summariseCoverage(topicCoverage)
      await persist({
        completedCycles: ['write'],
        finalCoverageSummary,
      })
      progress.finish('write', `${writtenDocIds.length} docs written`)
      return {
        status: 'accepted',
        base: options.base,
        apply: options.apply,
        completedCycles: checkpoint.completedCycles,
        writtenDocIds,
        checkpointFile,
        resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
        coverageSummary: finalCoverageSummary,
      }
    }

    progress.finish('write', 'reused from checkpoint')
  } catch (error) {
    if (error instanceof InitPausedError) {
      paused = true
    } else {
      throw error
    }
  } finally {
    await questionIO.close?.()
  }

  return {
    status: paused ? 'paused' : 'accepted',
    base: options.base,
    apply: options.apply,
    completedCycles: checkpoint.completedCycles,
    checkpointFile,
    resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
    coverageSummary: checkpoint.finalCoverageSummary ?? summariseCoverage(checkpoint.topicCoverage ?? []),
  }
}

async function runReadInputsCycle(options: {
  cwd: string
  nonInteractive: boolean
  detach?: boolean
  questionIO: InitQuestionIO
  startingRound: number
  maxQuestions: number
}): Promise<{
  context: InitContext
  interviewRound?: InitInterviewRound
  topicCoverage: TopicCoverageAssessment[]
  paused?: boolean
}> {
  const sourceFiles = await collectSourceFiles(options.cwd)
  const context: InitContext = {
    sourceFiles,
    userAnswers: [],
  }

  if (options.nonInteractive) {
    return {
      context,
      topicCoverage: assessTopicCoverage(context, undefined, true),
    }
  }

  const initialQuestions = planInitialQuestions(sourceFiles, options.startingRound, options.maxQuestions)
  if (initialQuestions.length === 0) {
    return {
      context,
      topicCoverage: assessTopicCoverage(context, undefined, false),
    }
  }

  const heading = Object.keys(sourceFiles).length > 0
    ? '\n[kb init] A few quick questions to fill in gaps (press Enter to skip):\n\n'
    : '\n[kb init] No README found. Answering these questions will seed your KB:\n\n'

  if (options.detach) {
    return {
      context,
      interviewRound: {
        round: initialQuestions[0]?.round ?? options.startingRound,
        questions: initialQuestions,
      },
      topicCoverage: assessTopicCoverage(context, undefined, false),
      paused: true,
    }
  }

  const interviewRound = await askQuestions({
    heading,
    questions: initialQuestions,
    questionIO: options.questionIO,
  })
  const mergedContext = mergeInterviewAnswersIntoContext(context, interviewRound)

  return {
    context: mergedContext,
    interviewRound,
    topicCoverage: assessTopicCoverage(mergedContext, undefined, false),
  }
}

async function collectSourceFiles(cwd: string): Promise<Record<string, string>> {
  const sourceFiles: Record<string, string> = {}

  for (const candidate of SOURCE_FILE_CANDIDATES) {
    const fullPath = path.join(cwd, candidate)
    if (!existsSync(fullPath)) continue
    const content = await readFile(fullPath, 'utf8')
    sourceFiles[candidate] = content.slice(0, MAX_SOURCE_SIZE)
  }

  try {
    const topLevel = await readdir(cwd)
    for (const file of topLevel) {
      if (!file.endsWith('.md') || sourceFiles[file] || Object.keys(sourceFiles).length >= 8) continue
      const content = await readFile(path.join(cwd, file), 'utf8')
      sourceFiles[file] = content.slice(0, MAX_SOURCE_SIZE)
    }
  } catch {
    // Ignore directory listing failures.
  }

  return sourceFiles
}

function planInitialQuestions(
  sourceFiles: Record<string, string>,
  round: number,
  maxQuestions: number,
): InitInterviewQuestion[] {
  const combined = Object.values(sourceFiles).join('\n').toLowerCase()
  const topicsToAsk = INIT_TOPIC_DEFINITIONS.filter(definition => {
    if (Object.keys(sourceFiles).length === 0) return true
    return !definition.keywords.some(keyword => combined.includes(keyword))
  }).slice(0, maxQuestions)

  return topicsToAsk.map(definition => buildInterviewQuestion(
    definition.topic,
    definition.initialQuestion,
    round,
    'missing-topic',
  ))
}

function planFollowUpQuestions(options: {
  topicCoverage: TopicCoverageAssessment[]
  existingRounds: InitInterviewRound[]
  round: number
  maxQuestions: number
}): InitInterviewQuestion[] {
  if (options.maxQuestions <= 0) {
    return []
  }

  const alreadyAskedTopics = new Set(
    options.existingRounds.flatMap(round => round.questions.map(question => `${question.topic}:${question.reason}`)),
  )

  const candidates = buildTopicCoverageGaps(options.topicCoverage)
    .filter(topic => !alreadyAskedTopics.has(`${topic.topic}:${topic.reason}`))
    .slice(0, options.maxQuestions)

  return candidates.map(topic => {
    const definition = getTopicDefinition(topic.topic)
    return buildInterviewQuestion(topic.topic, definition.followUpQuestion, options.round, topic.reason)
  })
}

async function answerPendingQuestions(options: {
  heading: string
  round: InitInterviewRound
  questionIO: InitQuestionIO
}): Promise<InitInterviewRound> {
  const unanswered = options.round.questions.filter(question => !question.answer)
  if (unanswered.length === 0) {
    return options.round
  }

  const answeredRound = await askQuestions({
    heading: options.heading,
    questions: unanswered,
    questionIO: options.questionIO,
  })

  const answeredById = new Map(answeredRound.questions.map(question => [question.id, question]))
  return {
    round: options.round.round,
    questions: options.round.questions.map(question => answeredById.get(question.id) ?? question),
  }
}

async function askQuestions(options: {
  heading: string
  questions: InitInterviewQuestion[]
  questionIO: InitQuestionIO
}): Promise<InitInterviewRound> {
  options.questionIO.write?.(options.heading)

  const questions: InitInterviewQuestion[] = []
  for (const question of options.questions) {
    const askedAt = dayjs().toISOString()
    const answer = (await options.questionIO.askQuestion(`  > ${question.question}\n    `)).trim()
    questions.push({
      ...question,
      askedAt,
      answer: answer.length > 0 ? answer : undefined,
      answeredAt: answer.length > 0 ? dayjs().toISOString() : undefined,
    })
  }

  options.questionIO.write?.('\n')

  return {
    round: options.questions[0]?.round ?? 1,
    questions,
  }
}

function mergeInterviewAnswersIntoContext(context: InitContext, round: InitInterviewRound): InitContext {
  const userAnswers = [
    ...context.userAnswers,
    ...round.questions
      .filter(question => question.answer)
      .map(question => ({
        question: question.question,
        answer: question.answer!,
        topic: question.topic,
      })),
  ]

  return {
    ...context,
    userAnswers,
  }
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

  const prompt = `You are a knowledge base architect. Your job is to extract structured, retrieval-ready fact documents from project documentation.

You are initialising a knowledge base for the project base "${baseName}".

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
    messages: [{ role: 'user', content: prompt }],
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
  const prompt = `You are refining a set of KB documents for quality and completeness.

## Current documents
${JSON.stringify(docs, null, 2)}

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
  const prompt = `You are doing a final quality pass on KB documents before they are written to storage.

## Documents
${JSON.stringify(docs, null, 2)}

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

function parseDocArray(text: string): CandidateDoc[] | null {
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as unknown[]
    if (!Array.isArray(parsed)) return null
    const docs = parsed.filter(
      (item): item is CandidateDoc =>
        typeof item === 'object' &&
        item !== null &&
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
    .map(([file, value]) => `## ${file}\n${value}`)
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

function createReadlineQuestionIO(): InitQuestionIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    write(message: string) {
      process.stdout.write(message)
    },
    askQuestion(question: string) {
      return new Promise(resolve => {
        rl.question(question, answer => resolve(answer))
      })
    },
    close() {
      rl.close()
    },
  }
}

function buildInterviewQuestion(
  topic: InitTopic,
  question: string,
  round: number,
  reason: InitInterviewQuestion['reason'],
): InitInterviewQuestion {
  return {
    id: `${topic}-${reason}-${round}`,
    round,
    topic,
    reason,
    question,
  }
}

function remainingQuestionBudget(rounds: InitInterviewRound[]): number {
  const askedQuestions = rounds.reduce((total, round) => total + round.questions.length, 0)
  return Math.max(MAX_TOTAL_QUESTIONS - askedQuestions, 0)
}

function appendRoundIfPresent(
  rounds: InitInterviewRound[],
  round: InitInterviewRound | undefined,
): InitInterviewRound[] {
  if (!round) return rounds
  return [...rounds, round]
}

function replaceInterviewRound(
  rounds: InitInterviewRound[],
  round: InitInterviewRound,
): InitInterviewRound[] {
  return rounds.map(existing => existing.round === round.round ? round : existing)
}

function hasPendingQuestions(rounds: InitInterviewRound[]): boolean {
  return rounds.some(round => round.questions.some(question => !question.answer))
}

function latestPendingRound(rounds: InitInterviewRound[]): InitInterviewRound | undefined {
  return [...rounds].reverse().find(round => round.questions.some(question => !question.answer))
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document'
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
    return path.resolve(cwd, options.resumeFrom ?? options.checkpointFile!)
  }
  if (options.resume) {
    return path.join(cwd, '.tmp', 'kb-init', `${slugify(options.base)}-latest.checkpoint.json`)
  }
  return path.join(cwd, '.tmp', 'kb-init', `${slugify(options.base)}-latest.checkpoint.json`)
}

async function readCheckpoint(filePath: string): Promise<InitCheckpoint | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return migrateCheckpoint(JSON.parse(raw) as StoredInitCheckpoint)
  } catch {
    return undefined
  }
}

function migrateCheckpoint(checkpoint: StoredInitCheckpoint): InitCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint !== 'object') return undefined
  if ('version' in checkpoint && checkpoint.version === 2) {
    return checkpoint
  }
  if ('version' in checkpoint && checkpoint.version === 1) {
    return {
      version: 2,
      updatedAt: checkpoint.updatedAt,
      baseName: checkpoint.baseName,
      workingDir: checkpoint.workingDir,
      completedCycles: checkpoint.completedCycles,
      context: checkpoint.context
        ? {
          sourceFiles: checkpoint.context.sourceFiles ?? {},
          userAnswers: (checkpoint.context.userAnswers ?? []).map(answer => ({
            question: answer.question,
            answer: answer.answer,
            topic: inferTopicFromQuestion(answer.question),
          })),
        }
        : undefined,
      candidateDocs: checkpoint.candidateDocs,
      interviewRounds: checkpoint.context?.userAnswers?.length
        ? [{
          round: 1,
          questions: checkpoint.context.userAnswers.map((answer, index) => ({
            id: `migrated-${index}`,
            round: 1,
            topic: inferTopicFromQuestion(answer.question) ?? 'project-overview',
            reason: 'missing-topic',
            question: answer.question,
            answer: answer.answer,
            askedAt: checkpoint.updatedAt,
            answeredAt: checkpoint.updatedAt,
          })),
        }]
        : [],
      topicCoverage: assessTopicCoverage({
        sourceFiles: checkpoint.context?.sourceFiles ?? {},
        userAnswers: (checkpoint.context?.userAnswers ?? []).map(answer => ({
          question: answer.question,
          answer: answer.answer,
          topic: inferTopicFromQuestion(answer.question),
        })),
      }, checkpoint.candidateDocs, false),
      finalCoverageSummary: undefined,
    }
  }
  return undefined
}

async function writeCheckpoint(filePath: string, checkpoint: InitCheckpoint): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function dedup<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

class InitPausedError extends Error {
  constructor(readonly cycle: InitCycle) {
    super(`Init paused after ${cycle}`)
  }
}
