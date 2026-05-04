/**
 * kb init — knowledge base bootstrap command.
 *
 * Cycle 1 (read-inputs):     Discover markdown/text sources under working dir (recursive),
 *                             ask an initial interview round via stdin.
 * Cycle 2 (markdown-facts):  Deterministic sentence segmentation of source markdown → `facts` table
 *                             (before synthesis; placeholder triplets).
 * Cycle 3 (code-facts):      Per-file LLM pass that extracts semantic facts from source code,
 *                             anchored by `code:<path>@<symbol>` for repair-friendly rescans.
 * Cycle 4 (import-docs):     One `is_original` SQLite doc per collected markdown file (verbatim body).
 * Cycle 5 (write):           Upsert documents.
 * Cycle 6 (pass-graph):      Graph extraction (optional provider).
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import dayjs from 'dayjs'
import { DOC_TYPES } from '../core/doc-taxonomy'
import { ingestCodeFilesAsFacts } from '../core/code-fact-extract'
import { ingestSourceMarkdownFilesAsFacts } from '../core/scan-fact-ingest'
import type { RunCollector } from '../core/telemetry'
import { TokenCountingProvider, estimateCost } from '../core/telemetry'
import type { LLMProvider } from '../core/types'
import type { WriteDocumentInput } from '../tools/document-writer'
import { KbGraphWriter } from '../tools/kb-graph-writer'
import { extractGraphBatch } from '../tools/graph-entity-extractor'
import {
  type RunRescanApplyOrchestratorResult,
  runRescanApplyOrchestrator,
} from '../tools/rescan-apply-orchestrator'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { ensureOperationalBaseDir, getKbHomeDir, readBaseConfig } from './base-selection'
import { CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE } from './cli-prerequisites'
import {
  buildHashesFor,
  diffChangedFiles,
  readCodeFactsManifest,
  writeCodeFactsManifest,
} from './init-code-facts-manifest'
import { readKnowledgeGraphInitSummary } from './graph-cli'
import {
  INIT_TOPIC_DEFINITIONS,
  assessTopicCoverage,
  inferTopicFromQuestion,
  summariseCoverage,
} from './init-topic-coverage'
import { createLLMProviderFromConfig, readKbConfig, resolveGraphEnabled } from './kb-config'

export type InitCycle =
  | 'read-inputs'
  | 'markdown-facts'
  | 'code-facts'
  | 'import-docs'
  | 'write'
  | 'pass-graph'
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
  base?: string
  nonInteractive: boolean
  rescan?: boolean
  apply?: boolean
  detach?: boolean
  resume?: boolean
  stopAfter?: InitCycle
  resumeFrom?: string
  checkpointFile?: string
  cwd?: string
  provider?: LLMProvider
  questionIO?: InitQuestionIO
  progressSink?: (line: string) => void
  collector?: RunCollector
  debug?: boolean
}

export interface InitResult {
  status: 'accepted' | 'paused'
  base: string
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
  /** Lightweight source-code index: file path → first N chars of content. Feeds synthesis passes. */
  codeFiles: Record<string, string>
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
  isOriginal?: boolean
}

const VALID_DOC_TYPES = new Set<NonNullable<CandidateDoc['type']>>(DOC_TYPES)

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
  version: 3
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

type StoredInitCheckpoint = InitCheckpointV1 | InitCheckpoint | LegacyInitCheckpointV2

/** v2 checkpoints used old synthesis cycles — not resumed; user must delete checkpoint and re-run. */
interface LegacyInitCheckpointV2 {
  version: 2
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: string[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
  interviewRounds?: InitInterviewRound[]
  topicCoverage?: TopicCoverageAssessment[]
  finalCoverageSummary?: InitCoverageSummary
}

export interface InitQuestionIO {
  write?: (message: string) => void
  askQuestion: (question: string) => Promise<string>
  close?: () => Promise<void> | void
}

class InitProgressReporter {
  private completed = 0

  constructor(
    private total: number,
    private sink: (line: string) => void = line => process.stderr.write(line)
  ) {}

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
    this.sink(`[init] [${bar}] ${this.completed}/${this.total} ${label}${suffix}\n`)
  }
}

const SOURCE_FILE_CANDIDATES = [
  'README.md',
  'README.txt',
  'readme.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docs/README.md',
  'docs/overview.md',
  'docs/architecture.md',
]

/** Dirs skipped when collecting markdown/text sources (keep aligned with `SOURCE_CODE_EXCLUDE_DIRS` plus KB/publish paths). */
const MARKDOWN_SOURCE_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '_site',
  '.git',
  'vendor',
  'coverage',
  '.next',
  'out',
  '.cache',
  '__pycache__',
  '.turbo',
  '.kb',
  '_original_docs',
  '_autogenerated_docs',
  'venv',
  '.venv',
])

const MARKDOWN_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mdx', '.txt'])
const MAX_MARKDOWN_SOURCE_FILES = 500
const MAX_MARKDOWN_SOURCE_TOTAL_CHARS = 12_000_000
const MAX_MARKDOWN_SINGLE_FILE_CHARS = 2_000_000

const MAX_TOTAL_QUESTIONS = 10
export function parseInitCommand(args: string[]): InitOptions {
  const base = readOption(args, '--base') ?? undefined

  const stopAfter = readOption(args, '--stop-after') as InitCycle | undefined
  const validCycles: InitCycle[] = [
    'read-inputs',
    'markdown-facts',
    'code-facts',
    'import-docs',
    'write',
    'pass-graph',
  ]
  if (stopAfter && !validCycles.includes(stopAfter)) {
    throw new Error(`Invalid --stop-after. Use: ${validCycles.join('|')}`)
  }

  const rescan = readFlag(args, '--rescan')
  const apply = readFlag(args, '--apply')
  const resume = readFlag(args, '--resume')
  if (rescan && resume) {
    throw new Error('Invalid flags: --rescan cannot be combined with --resume.')
  }
  if (apply && !rescan) {
    throw new Error('Invalid flags: --apply requires --rescan.')
  }

  return {
    base,
    nonInteractive: readFlag(args, '--non-interactive'),
    rescan,
    apply,
    detach: readFlag(args, '--detach'),
    resume,
    stopAfter,
    resumeFrom: readOption(args, '--resume-from'),
    checkpointFile: readOption(args, '--checkpoint-file'),
    debug: readFlag(args, '--debug'),
  }
}

function makeCycleTimer(
  cycle: InitCycle,
  provider: LLMProvider | undefined,
  collector: RunCollector | undefined,
  counter?: TokenCountingProvider
): () => void {
  if (!collector) return () => {}
  const startMs = Date.now()
  const startedAt = new Date().toISOString()
  const providerName = provider?.name ?? 'unknown'
  const model = provider?.model ?? 'unknown'
  return () => {
    const { inputTokens, outputTokens } = counter?.getAndReset() ?? {
      inputTokens: 0,
      outputTokens: 0,
    }
    collector.addStage({
      stage: cycle,
      startedAt,
      durationMs: Date.now() - startMs,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost(providerName, model, inputTokens, outputTokens),
      provider: providerName,
      model,
    })
  }
}

export async function runKbInit(inputOptions: InitOptions): Promise<InitResult> {
  // When using real readline (no injected questionIO) and stdin is not a TTY
  // (e.g. CI, background process, piped input), force non-interactive mode so
  // readline doesn't throw "readline was closed".
  const options =
    !inputOptions.questionIO && !process.stdin.isTTY
      ? { ...inputOptions, nonInteractive: true }
      : inputOptions

  const questionIO = options.questionIO ?? createReadlineQuestionIO()
  const cwd = options.cwd ?? process.cwd()
  const base = await resolveInitBaseName(options, cwd, questionIO)
  const baseDir = await ensureOperationalBaseDir(base, cwd)
  if (options.rescan && !options.nonInteractive) {
    const proceed = await confirmRescanStart(questionIO, base, cwd)
    if (!proceed) {
      throw new Error('Rescan canceled.')
    }
  }
  const checkpointFile = await resolveCheckpointPath({ ...options, base }, cwd)
  const resumedCheckpoint = options.rescan ? undefined : await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(6, options.progressSink)
  const rawProvider = options.provider ?? (await resolveProvider())
  const counter =
    rawProvider && options.collector ? new TokenCountingProvider(rawProvider) : undefined
  const provider = counter ?? rawProvider
  const kbConfig = await readKbConfig()
  const graphEnabled = resolveGraphEnabled(kbConfig)

  let checkpoint: InitCheckpoint = resumedCheckpoint ?? {
    version: 3,
    updatedAt: dayjs().toISOString(),
    baseName: base,
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
      completedCycles: dedup([
        ...(checkpoint.completedCycles ?? []),
        ...(updates.completedCycles ?? []),
      ]),
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
          baseDir,
          baseName: base,
          rescan: options.rescan === true,
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
        `${Object.keys(context.sourceFiles).length} files, ${context.userAnswers.length} answers`
      )
      if (options.stopAfter === 'read-inputs') throw new InitPausedError('read-inputs')
    } else {
      progress.finish('read-inputs', 'reused from checkpoint')
    }

    if (!context) throw new Error('read-inputs context missing')

    if (!checkpoint.completedCycles.includes('markdown-facts')) {
      progress.start('markdown-facts', 'indexing source sentences into facts…')
      const endScanFacts = makeCycleTimer('markdown-facts', provider, options.collector, counter)
      const ingestStats = ingestSourceMarkdownFilesAsFacts({
        baseDir,
        files: context.sourceFiles,
      })
      endScanFacts()
      await persist({
        completedCycles: ['markdown-facts'],
      })
      progress.finish(
        'markdown-facts',
        `${ingestStats.segmentsUpserted} segments from ${ingestStats.filesScanned} files${
          ingestStats.segmentsSkippedShort > 0 ? ` (${ingestStats.segmentsSkippedShort} too short)` : ''
        }`
      )
      if (options.stopAfter === 'markdown-facts') throw new InitPausedError('markdown-facts')
    } else {
      progress.finish('markdown-facts', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('code-facts')) {
      progress.start('code-facts', 'extracting semantic facts from source code…')
      const endCodeFacts = makeCycleTimer('code-facts', provider, options.collector, counter)
      const codeFiles = context.codeFiles ?? {}
      if (!provider) {
        endCodeFacts()
        await persist({ completedCycles: ['code-facts'] })
        progress.finish('code-facts', 'skipped (no LLM provider configured)')
      } else if (Object.keys(codeFiles).length === 0) {
        endCodeFacts()
        await persist({ completedCycles: ['code-facts'] })
        progress.finish('code-facts', 'skipped (no source files crawled)')
      } else {
        const manifest = await readCodeFactsManifest(baseDir)
        const candidateFiles = options.rescan
          ? (diffChangedFiles(codeFiles, manifest) ?? Object.keys(codeFiles))
          : undefined
        if (options.rescan) {
          options.questionIO?.write?.(
            `[kb init] code-facts --rescan picked ${candidateFiles?.length ?? 0}/${Object.keys(codeFiles).length} changed source file(s).\n`
          )
        }
        try {
          const codeFactStats = await ingestCodeFilesAsFacts({
            baseDir,
            llm: provider,
            codeFiles,
            candidateFiles,
          })
          await writeCodeFactsManifest(baseDir, buildHashesFor(codeFiles))
          endCodeFacts()
          await persist({ completedCycles: ['code-facts'] })
          progress.finish(
            'code-facts',
            `${codeFactStats.factsInserted} new, ${codeFactStats.factsSuperseded} superseded, ${codeFactStats.factsTombstoned} tombstoned across ${codeFactStats.filesProcessed}/${codeFactStats.filesConsidered} file(s)`
          )
        } catch (err) {
          endCodeFacts()
          const message = err instanceof Error ? err.message : String(err)
          options.questionIO?.write?.(
            `[kb init] code-facts cycle failed: ${message}. Continuing without code-derived facts.\n`
          )
          await persist({ completedCycles: ['code-facts'] })
          progress.finish('code-facts', `failed (${message.slice(0, 80)})`)
        }
      }
      if (options.stopAfter === 'code-facts') throw new InitPausedError('code-facts')
    } else {
      progress.finish('code-facts', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('import-docs')) {
      progress.start('import-docs', 'importing original markdown…')
      const endImport = makeCycleTimer('import-docs', provider, options.collector, counter)
      candidateDocs = normalizeInitDocs(buildOriginalDocumentsFromSourceFiles(context.sourceFiles, base), {
        minWords: 0,
      })
      endImport()
      topicCoverage = assessTopicCoverage(context, candidateDocs, options.nonInteractive)
      const finalCoverageSummary = summariseCoverage(topicCoverage)
      await persist({
        candidateDocs,
        topicCoverage,
        finalCoverageSummary,
        completedCycles: ['import-docs'],
      })
      progress.finish('import-docs', `${candidateDocs.length} original doc(s)`)
      if (options.stopAfter === 'import-docs') throw new InitPausedError('import-docs')
    } else {
      progress.finish('import-docs', 'reused from checkpoint')
    }

    if (!candidateDocs) throw new Error('import-docs candidateDocs missing')

    let writtenDocIds: string[] | undefined
    if (!checkpoint.completedCycles.includes('write')) {
      progress.start('write', baseDir)
      if (options.rescan) {
        let originalWritten: string[] = []
        {
          const originals = candidateDocs.filter(doc => doc.isOriginal)
          if (originals.length > 0) {
            originalWritten = await writeDocs(originals, baseDir, base)
          }
        }
        const planResult = await runRescanApplyOrchestrator({
          base,
          baseDir,
          cwd,
          apply: false,
          sourceFiles: context.sourceFiles,
          candidateDocs,
        })
        let mutationWritten: string[] = []
        questionIO.write?.(
          `[kb init] rescan plan: ${planResult.plan.mutations.length} actions (${planResult.plan.apply.noopMutations} noop) [plan-only].\n`
        )
        questionIO.write?.(`[kb init] rescan plan preview:\n${planResult.previewDiff}\n`)
        const safeguards = planResult.plan.safeguards?.triggered ?? []
        if (safeguards.length > 0) {
          questionIO.write?.(`[kb init] rescan safeguards triggered: ${safeguards.join(', ')}\n`)
        }
        if (!options.apply) {
          questionIO.write?.(
            '[kb init] rescan apply is disabled by default. Re-run with --rescan --apply to execute planned mutations.\n'
          )
        } else if (options.nonInteractive || (await confirmRescanApply(questionIO, planResult))) {
          const applyResult = await runRescanApplyOrchestrator({
            base,
            baseDir,
            cwd,
            apply: true,
            sourceFiles: context.sourceFiles,
            candidateDocs,
          })
          mutationWritten = applyResult.writtenDocIds
          questionIO.write?.(
            `[kb init] rescan apply: ${applyResult.plan.apply.appliedMutations} actions applied (${applyResult.plan.apply.noopMutations} noop).\n`
          )
        } else {
          questionIO.write?.('[kb init] rescan apply canceled by user; no mutations executed.\n')
        }
        writtenDocIds = [...originalWritten, ...mutationWritten]
      } else {
        writtenDocIds = await writeDocs(candidateDocs, baseDir, base)
      }
      const finalCoverageSummary =
        checkpoint.finalCoverageSummary ?? summariseCoverage(topicCoverage)
      await persist({
        completedCycles: ['write'],
        finalCoverageSummary,
      })
      progress.finish('write', `${writtenDocIds.length} docs written`)
      if (options.stopAfter === 'write') throw new InitPausedError('write')
    } else {
      progress.finish('write', 'reused from checkpoint')
    }

    let graphPassOutcome: GraphPassOutcome = 'reused'
    let graphError: string | undefined
    if (!checkpoint.completedCycles.includes('pass-graph')) {
      progress.start('pass-graph', 'extracting knowledge graph…')
      if (options.rescan && options.apply !== true) {
        graphPassOutcome = 'preview'
        progress.finish('pass-graph', 'skipped (rescan preview)')
        await persist({ completedCycles: ['pass-graph'] })
      } else if (!graphEnabled) {
        graphPassOutcome = 'disabled'
        progress.finish('pass-graph', 'skipped (graph disabled)')
        await persist({ completedCycles: ['pass-graph'] })
      } else if (provider) {
        try {
          const endPassGraph = makeCycleTimer('pass-graph', provider, options.collector, counter)
          await runGraphExtractionPass(provider, baseDir)
          endPassGraph()
          graphPassOutcome = 'extracted'
          await persist({ completedCycles: ['pass-graph'] })
          progress.finish('pass-graph', 'graph written to .kb-index.sqlite')
        } catch (err) {
          // Graph extraction failed. The graph transaction was rolled back, so
          // the DB is clean. Mark pass-graph complete so plain `kb init` does not
          // retry endlessly; the user can force a retry with `kb init --rescan`.
          graphError = err instanceof Error ? err.message : String(err)
          graphPassOutcome = 'failed'
          await persist({ completedCycles: ['pass-graph'] })
          progress.finish('pass-graph', `failed (${graphError ?? 'unknown error'})`)
        }
      } else {
        graphPassOutcome = 'no-provider'
        progress.finish('pass-graph', 'skipped (no provider)')
        await persist({ completedCycles: ['pass-graph'] })
      }
      if (options.stopAfter === 'pass-graph') throw new InitPausedError('pass-graph')
    } else {
      progress.finish('pass-graph', 'reused from checkpoint')
    }

    await emitPostInitGraphOverview({
      baseDir,
      graphPassOutcome,
      questionIO,
      graphError,
    })

    const finalCoverageSummary = checkpoint.finalCoverageSummary ?? summariseCoverage(topicCoverage)
    return {
      status: 'accepted',
      base,
      completedCycles: checkpoint.completedCycles,
      writtenDocIds,
      checkpointFile,
      resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
      coverageSummary: finalCoverageSummary,
    }
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
    base,
    completedCycles: checkpoint.completedCycles,
    checkpointFile,
    resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
    coverageSummary:
      checkpoint.finalCoverageSummary ?? summariseCoverage(checkpoint.topicCoverage ?? []),
  }
}

async function runReadInputsCycle(options: {
  cwd: string
  baseDir: string
  baseName: string
  rescan: boolean
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
  const sourceFiles = options.rescan
    ? await collectRescanSourceFiles({
        cwd: options.cwd,
        baseDir: options.baseDir,
        baseName: options.baseName,
        questionIO: options.questionIO,
      })
    : await collectSourceFiles(options.cwd)
  const codeFiles = await crawlSourceCode(options.cwd)
  const context: InitContext = {
    sourceFiles,
    codeFiles,
    userAnswers: [],
  }

  if (options.nonInteractive || options.rescan) {
    return {
      context,
      topicCoverage: assessTopicCoverage(context, undefined, true),
    }
  }

  const initialQuestions = planInitialQuestions(
    sourceFiles,
    options.startingRound,
    options.maxQuestions
  )
  if (initialQuestions.length === 0) {
    return {
      context,
      topicCoverage: assessTopicCoverage(context, undefined, false),
    }
  }

  const heading =
    Object.keys(sourceFiles).length > 0
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
  const seenPaths = new Set<string>()
  let totalChars = 0

  const addSourceFile = async (relativePath: string): Promise<boolean> => {
    const normalizedKey = relativePath.replace(/\\/g, '/').toLowerCase()
    if (seenPaths.has(normalizedKey)) return false
    if (Object.keys(sourceFiles).length >= MAX_MARKDOWN_SOURCE_FILES) return false
    if (totalChars >= MAX_MARKDOWN_SOURCE_TOTAL_CHARS) return false
    const fullPath = path.join(cwd, relativePath)
    if (!existsSync(fullPath)) return false
    try {
      const content = await readFile(fullPath, 'utf8')
      if (content.length > MAX_MARKDOWN_SINGLE_FILE_CHARS) return false
      if (totalChars + content.length > MAX_MARKDOWN_SOURCE_TOTAL_CHARS) return false
      sourceFiles[relativePath.replace(/\\/g, '/')] = content
      seenPaths.add(normalizedKey)
      totalChars += content.length
      return true
    } catch {
      return false
    }
  }

  for (const candidate of SOURCE_FILE_CANDIDATES) {
    await addSourceFile(candidate)
  }

  async function walkMarkdownTree(absDir: string): Promise<void> {
    if (Object.keys(sourceFiles).length >= MAX_MARKDOWN_SOURCE_FILES) return
    if (totalChars >= MAX_MARKDOWN_SOURCE_TOTAL_CHARS) return

    let entries: { name: string; isDir: boolean }[]
    try {
      const raw = await readdir(absDir, { withFileTypes: true })
      entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return
    }

    for (const entry of entries) {
      if (Object.keys(sourceFiles).length >= MAX_MARKDOWN_SOURCE_FILES) break
      if (totalChars >= MAX_MARKDOWN_SOURCE_TOTAL_CHARS) break
      if (entry.name.startsWith('.')) continue

      const absPath = path.join(absDir, entry.name)
      if (entry.isDir) {
        if (MARKDOWN_SOURCE_EXCLUDE_DIRS.has(entry.name)) continue
        await walkMarkdownTree(absPath)
      } else {
        const ext = path.extname(entry.name).toLowerCase()
        if (!MARKDOWN_TEXT_EXTENSIONS.has(ext)) continue
        const relPath = path.relative(cwd, absPath)
        await addSourceFile(relPath)
      }
    }
  }

  try {
    await walkMarkdownTree(cwd)
  } catch {
    // Ignore walk failures (e.g. permission errors).
  }

  return sourceFiles
}

async function collectRescanSourceFiles(options: {
  cwd: string
  baseDir: string
  baseName: string
  questionIO: InitQuestionIO
}): Promise<Record<string, string>> {
  void options.baseDir
  void options.baseName
  const allSourceFiles = await collectSourceFiles(options.cwd)
  const n = Object.keys(allSourceFiles).length
  if (n === 0) {
    options.questionIO.write?.(
      '[kb init] --rescan found no markdown/text sources under the working directory.\n'
    )
  } else {
    options.questionIO.write?.(`[kb init] --rescan loaded ${n} markdown/text source file(s).\n`)
  }
  return allSourceFiles
}

export const SOURCE_CODE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.go',
  '.rb',
  '.java',
  '.rs',
  '.swift',
  '.kt',
]
export const SOURCE_CODE_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '_site',
  '.git',
  'vendor',
  'coverage',
  '.next',
  'out',
  '.cache',
  '__pycache__',
  '.turbo',
])
const SOURCE_CODE_MAX_FILES = 200
export const SOURCE_CODE_PER_FILE_CHARS = 400
const SOURCE_CODE_MAX_TOTAL_CHARS = 60_000

/**
 * Crawl the repo for source code files and return a lightweight index:
 * file path → first N chars of content (enough to see exports/signatures).
 * This feeds the synthesis passes so the LLM can reason about code structure,
 * not just documentation.
 */
export async function crawlSourceCode(cwd: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  let totalChars = 0

  async function walk(dir: string): Promise<void> {
    if (totalChars >= SOURCE_CODE_MAX_TOTAL_CHARS) return
    if (Object.keys(result).length >= SOURCE_CODE_MAX_FILES) return

    let entries: { name: string; isDir: boolean }[]
    try {
      const raw = await readdir(dir, { withFileTypes: true })
      entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return
    }

    for (const entry of entries) {
      if (totalChars >= SOURCE_CODE_MAX_TOTAL_CHARS) break
      if (Object.keys(result).length >= SOURCE_CODE_MAX_FILES) break
      if (entry.name.startsWith('.')) continue

      if (entry.isDir) {
        if (SOURCE_CODE_EXCLUDE_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
      } else {
        const ext = path.extname(entry.name).toLowerCase()
        if (!SOURCE_CODE_EXTENSIONS.includes(ext)) continue
        const fullPath = path.join(dir, entry.name)
        try {
          const content = await readFile(fullPath, 'utf8')
          const snippet = content.slice(0, SOURCE_CODE_PER_FILE_CHARS)
          const relPath = path.relative(cwd, fullPath)
          result[relPath] = snippet
          totalChars += snippet.length
        } catch {
          // unreadable — skip
        }
      }
    }
  }

  await walk(cwd)
  return result
}

function planInitialQuestions(
  sourceFiles: Record<string, string>,
  round: number,
  maxQuestions: number
): InitInterviewQuestion[] {
  const combined = Object.values(sourceFiles).join('\n').toLowerCase()
  const topicsToAsk = INIT_TOPIC_DEFINITIONS.filter(definition => {
    if (Object.keys(sourceFiles).length === 0) return true
    return !definition.keywords.some(keyword => combined.includes(keyword))
  }).slice(0, maxQuestions)

  return topicsToAsk.map(definition =>
    buildInterviewQuestion(definition.topic, definition.initialQuestion, round, 'missing-topic')
  )
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

function mergeInterviewAnswersIntoContext(
  context: InitContext,
  round: InitInterviewRound
): InitContext {
  const userAnswers = [
    ...context.userAnswers,
    ...round.questions
      .filter((question): question is InitInterviewQuestion & { answer: string } =>
        Boolean(question.answer)
      )
      .map(question => ({
        question: question.question,
        answer: question.answer,
        topic: question.topic,
      })),
  ]

  return {
    ...context,
    userAnswers,
  }
}

type GraphPassOutcome = 'extracted' | 'disabled' | 'preview' | 'failed' | 'no-provider' | 'reused'

async function emitPostInitGraphOverview(options: {
  baseDir: string
  graphPassOutcome: GraphPassOutcome
  questionIO: InitQuestionIO
  graphError?: string
}): Promise<void> {
  const write = options.questionIO.write
  if (!write) return

  const banner =
    '\n--- Graph store (same text as `kb graph`; JSON is counts + top nodes, subset of `kb graph --format json`) ---\n'

  try {
    if (options.graphPassOutcome === 'disabled') {
      write(`${banner}Knowledge graph: skipped (disabled in kb config).\n`)
      return
    }
    if (options.graphPassOutcome === 'preview') {
      write(`${banner}Knowledge graph: skipped (rescan preview).\n`)
      return
    }
    if (options.graphPassOutcome === 'no-provider') {
      write(`${banner}Knowledge graph: skipped (no LLM provider for extraction).\n`)
      return
    }
    if (options.graphPassOutcome === 'failed') {
      const reason = options.graphError ? `: ${options.graphError}` : ''
      write(
        `${banner}Knowledge graph: extraction failed${reason}.\nThe graph is empty. Run \`kb init --rescan\` to retry graph extraction.\n`
      )
      return
    }

    const payload = await readKnowledgeGraphInitSummary(options.baseDir)
    if (!payload) {
      write(`${banner}Knowledge graph: no store file on disk yet.\n`)
      return
    }

    write(`${banner}${payload.human}\n\n${JSON.stringify(payload.json)}\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    write(`\n--- Graph store ---\nCould not read graph summary: ${msg}\n`)
  }
}

async function runGraphExtractionPass(provider: LLMProvider, baseDir: string): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  let docs: Array<{ id: string; text: string }>
  try {
    docs = indexer.getAllDocumentsForLexical().map(row => ({
      id: row.id,
      text: `${row.title}\n\n${row.content}`,
    }))
  } finally {
    indexer.close()
  }

  if (docs.length === 0) return

  const graphPath = KbGraphWriter.dbPathForBase(baseDir)
  const writer = new KbGraphWriter(graphPath)
  try {
    await writer.open()
    const { entities, relationships } = await extractGraphBatch(docs, provider)
    await writer.beginTransaction()
    try {
      if (entities.length > 0) await writer.upsertEntities(entities)
      if (relationships.length > 0) await writer.upsertRelationships(relationships)
      await writer.commit()
    } catch (err) {
      await writer.rollback()
      throw err
    }
  } finally {
    await writer.close()
  }
}

async function writeDocs(docs: CandidateDoc[], baseDir: string, base: string): Promise<string[]> {
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
      isOriginal: doc.isOriginal ?? false,
    })
    writtenIds.push(result.id)
  }

  return writtenIds
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

async function resolveInitBaseName(
  options: InitOptions,
  cwd: string,
  questionIO: InitQuestionIO
): Promise<string> {
  if (options.base?.trim()) {
    return options.base.trim()
  }

  if (options.rescan) {
    const { activeBase, defaultBase } = await readBaseConfig()
    const fromConfig = activeBase?.trim() || defaultBase?.trim()
    if (fromConfig) {
      return fromConfig
    }
    if (options.nonInteractive) {
      throw new Error(
        'No active or default KB base. Run `kb base use <name>` or `kb base use --default <name>`, or pass `--base <name>` to `kb init --rescan`.'
      )
    }
  }

  const suggestedBase = await resolveSuggestedInitBase(cwd)

  if (options.nonInteractive) {
    if (suggestedBase) {
      return suggestedBase
    }
    throw new Error(CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE)
  }

  questionIO.write?.('\n[kb init] Choose a knowledge base name for this run.\n\n')
  const prompt = suggestedBase
    ? `  > Knowledge base name [${suggestedBase}]\n    `
    : '  > Knowledge base name\n    '
  const answer = (await questionIO.askQuestion(prompt)).trim()
  const resolved = answer || suggestedBase
  if (!resolved) {
    throw new Error(
      'A knowledge base name is required. Use `kb init --base <name>` or enter one when prompted.'
    )
  }
  return resolved
}

async function resolveSuggestedInitBase(_cwd: string): Promise<string | undefined> {
  const configured = await readBaseConfig()
  if (configured.activeBase?.trim()) {
    return configured.activeBase.trim()
  }
  if (configured.defaultBase?.trim()) {
    return configured.defaultBase.trim()
  }
  return 'default'
}

function buildInterviewQuestion(
  topic: InitTopic,
  question: string,
  round: number,
  reason: InitInterviewQuestion['reason']
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
  round: InitInterviewRound | undefined
): InitInterviewRound[] {
  if (!round) return rounds
  return [...rounds, round]
}

function replaceInterviewRound(
  rounds: InitInterviewRound[],
  round: InitInterviewRound
): InitInterviewRound[] {
  return rounds.map(existing => (existing.round === round.round ? round : existing))
}

function hasPendingQuestions(rounds: InitInterviewRound[]): boolean {
  return rounds.some(round => round.questions.some(question => !question.answer))
}

function latestPendingRound(rounds: InitInterviewRound[]): InitInterviewRound | undefined {
  return [...rounds].reverse().find(round => round.questions.some(question => !question.answer))
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  )
}

function buildOriginalDocumentsFromSourceFiles(
  sourceFiles: Record<string, string>,
  baseName: string
): CandidateDoc[] {
  const out: CandidateDoc[] = []
  for (const relPath of Object.keys(sourceFiles).sort()) {
    const body = sourceFiles[relPath]
    if (typeof body !== 'string' || !body.trim()) continue
    const posixPath = relPath.replace(/\\/g, '/')
    const id = slugify(posixPath)
    out.push({
      id,
      title: posixPath,
      type: 'reference',
      tags: ['original-source', id, baseName],
      content: body,
      isOriginal: true,
    })
  }
  return out
}

function normalizeInitDocs(
  docs: CandidateDoc[],
  options: {
    fallback?: CandidateDoc[]
    preserveMinimumCount?: number
    minWords?: number
  } = {}
): CandidateDoc[] {
  const normalized: CandidateDoc[] = []
  const seenTitles = new Set<string>()

  for (const raw of docs) {
    const cleaned = normalizeInitDoc(raw, options.minWords ?? 0)
    if (!cleaned) continue
    const title = ensureUniqueTitle(cleaned.title, seenTitles)
    seenTitles.add(title.toLowerCase())
    normalized.push({ ...cleaned, title })
  }

  if (
    options.fallback &&
    typeof options.preserveMinimumCount === 'number' &&
    normalized.length < options.preserveMinimumCount
  ) {
    return normalizeInitDocs(options.fallback, { minWords: 0 })
  }

  return normalized.length > 0 ? normalized : (options.fallback ?? [])
}

function normalizeInitDoc(doc: CandidateDoc, minWords: number): CandidateDoc | null {
  if (doc.isOriginal) {
    const title = normalizeTitle(doc.title)
    const content = doc.content.trimEnd()
    if (!title || !content.trim()) return null
    const tags = doc.tags?.length ? normalizeTags(doc.tags) : normalizeTags(['original-source'])
    const type = VALID_DOC_TYPES.has(doc.type ?? 'reference')
      ? (doc.type ?? 'reference')
      : 'reference'
    return { ...doc, title, type, tags, content, isOriginal: true }
  }

  const title = normalizeTitle(doc.title)
  const content = normalizeContent(doc.content)
  if (!title || !content) return null
  if (countWords(content) < minWords) return null

  const tags = normalizeTags(doc.tags)
  const type = VALID_DOC_TYPES.has(doc.type ?? 'reference')
    ? (doc.type ?? 'reference')
    : 'reference'

  return {
    ...doc,
    title,
    type,
    tags,
    content: ensureSummaryLead(content),
  }
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function normalizeContent(value: string): string {
  const lines = value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !/^type:\s*/i.test(line))
    .filter(line => !/^tags:\s*/i.test(line))
    .filter(line => !/^created:\s*/i.test(line))
    .filter(line => !/^\*+\s*:/.test(line))
    .filter(line => !/^[-*]\s*$/.test(line))
    .filter(line => line !== '```')
  return lines.join('\n').trim()
}

function normalizeTags(tags: string[] | undefined): string[] {
  const cleaned = (tags ?? [])
    .map(tag =>
      tag
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean)
  return cleaned.length > 0 ? [...new Set(cleaned)] : ['general']
}

function ensureSummaryLead(content: string): string {
  const lines = content.split('\n').filter(Boolean)
  if (lines.length === 0) return content
  const first = lines[0]
  if (/[.!?]$/.test(first)) return lines.join('\n')
  lines[0] = `${first}.`
  return lines.join('\n')
}

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length
}

function ensureUniqueTitle(title: string, seenLowerTitles: Set<string>): string {
  if (!seenLowerTitles.has(title.toLowerCase())) return title
  let attempt = 2
  while (seenLowerTitles.has(`${title} ${attempt}`.toLowerCase())) {
    attempt += 1
  }
  return `${title} ${attempt}`
}

async function resolveProvider(): Promise<LLMProvider | undefined> {
  const config = await readKbConfig()
  return createLLMProviderFromConfig(config)
}

async function resolveCheckpointPath(options: InitOptions, cwd: string): Promise<string> {
  const explicitCheckpoint = options.resumeFrom ?? options.checkpointFile
  if (explicitCheckpoint) {
    return path.resolve(cwd, explicitCheckpoint)
  }
  const base = options.base?.trim()
  if (!base) {
    throw new Error('Base value is required to resolve kb init checkpoints')
  }
  const checkpointPath = path.join(
    getKbHomeDir(),
    'sessions',
    slugify(base),
    'checkpoints',
    'init-latest.checkpoint.json'
  )
  if (!(await pathExists(checkpointPath))) {
    await mkdir(path.dirname(checkpointPath), { recursive: true })
  }
  return checkpointPath
}

async function readCheckpoint(filePath: string): Promise<InitCheckpoint | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return migrateCheckpoint(JSON.parse(raw) as StoredInitCheckpoint)
  } catch {
    return undefined
  }
}

const VALID_V3_CYCLES = new Set<InitCycle>([
  'read-inputs',
  'markdown-facts',
  'code-facts',
  'import-docs',
  'write',
  'pass-graph',
])

/** Older checkpoints may list the markdown→facts cycle under its previous id. */
function normalizeStoredCycleId(cycle: string): InitCycle | null {
  if (cycle === 'scan-facts') return 'markdown-facts'
  if (VALID_V3_CYCLES.has(cycle as InitCycle)) return cycle as InitCycle
  return null
}

function normalizeCompletedCycles(cycles: unknown): InitCycle[] {
  if (!Array.isArray(cycles)) return []
  const out: InitCycle[] = []
  for (const entry of cycles) {
    if (typeof entry !== 'string') continue
    const normalized = normalizeStoredCycleId(entry)
    if (normalized) out.push(normalized)
  }
  return out
}

function migrateCheckpoint(checkpoint: StoredInitCheckpoint): InitCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint !== 'object') return undefined
  if ('version' in checkpoint && checkpoint.version === 3) {
    const cp = checkpoint as InitCheckpoint
    return {
      ...cp,
      completedCycles: normalizeCompletedCycles(cp.completedCycles),
    }
  }
  if ('version' in checkpoint && checkpoint.version === 2) {
    return undefined
  }
  if ('version' in checkpoint && checkpoint.version === 1) {
    const cycles = normalizeCompletedCycles(checkpoint.completedCycles)
    return {
      version: 3,
      updatedAt: checkpoint.updatedAt,
      baseName: checkpoint.baseName,
      workingDir: checkpoint.workingDir,
      completedCycles: cycles,
      context: checkpoint.context
        ? {
            sourceFiles: checkpoint.context.sourceFiles ?? {},
            codeFiles: {},
            userAnswers: (checkpoint.context.userAnswers ?? []).map(answer => ({
              question: answer.question,
              answer: answer.answer,
              topic: inferTopicFromQuestion(answer.question),
            })),
          }
        : undefined,
      candidateDocs: checkpoint.candidateDocs,
      interviewRounds: checkpoint.context?.userAnswers?.length
        ? [
            {
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
            },
          ]
        : [],
      topicCoverage: assessTopicCoverage(
        {
          sourceFiles: checkpoint.context?.sourceFiles ?? {},
          codeFiles: {},
          userAnswers: (checkpoint.context?.userAnswers ?? []).map(answer => ({
            question: answer.question,
            answer: answer.answer,
            topic: inferTopicFromQuestion(answer.question),
          })),
        },
        checkpoint.candidateDocs,
        false
      ),
      finalCoverageSummary: undefined,
    }
  }
  return undefined
}

async function writeCheckpoint(filePath: string, checkpoint: InitCheckpoint): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath)
    return true
  } catch {
    return false
  }
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

function readFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

async function confirmRescanStart(
  questionIO: InitQuestionIO,
  base: string,
  cwd: string
): Promise<boolean> {
  questionIO.write?.(
    `\n[kb init] Rescan base "${base}" using sources under:\n  ${cwd}\n\nVerbatim originals will be refreshed from discovered markdown. Claim mutations stay plan-only until you add \`--apply\`.\nProceed? [y/N]\n`
  )
  const answer = (await questionIO.askQuestion('  > ')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

async function confirmRescanApply(
  questionIO: InitQuestionIO,
  planResult: RunRescanApplyOrchestratorResult
): Promise<boolean> {
  questionIO.write?.(
    `[kb init] Apply ${planResult.plan.mutations.length} planned rescan action(s)? [y/N]\n`
  )
  const answer = (await questionIO.askQuestion('  > ')).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

function dedup<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

class InitPausedError extends Error {
  constructor(readonly cycle: InitCycle) {
    super(`Init paused after ${cycle}`)
  }
}
