/**
 * kb init — knowledge base bootstrap command.
 *
 * Cycle 1 (read-inputs):     Discover README/CLAUDE.md in working dir,
 *                             ask an initial interview round via stdin.
 * Cycle 2 (scan-facts):     Deterministic sentence scan of source markdown → `facts` table
 *                             (before synthesis; placeholder triplets).
 * Cycle 3 (pass1):           One LLM call per init topic (in parallel) from sources + Q&A.
 * Cycle 4 (pass2):           Follow-up questions for weak topics, LLM refinement.
 * Cycle 5 (pass-enrich):     Per-document enrichment — each doc gets a dedicated
 *                             LLM pass to deepen coverage and add concrete detail.
 * Cycle 6 (pass3):           Final quality pass — validate, dedupe, remove stubs.
 * Cycle 7 (write):           Upsert all candidate documents to SQLite.
 * Cycle 8 (pass-graph):      Extract knowledge graph entities and relationships.
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import dayjs from 'dayjs'
import { DOC_TYPES } from '../core/doc-taxonomy'
import {
  INIT_SYNTHESIS_GEMINI_RESPONSE_SCHEMA,
  INIT_SYNTHESIS_OPENAI_JSON_SCHEMA,
  parseInitSynthesisObject,
} from '../core/init-synthesis-json'
import { ingestSourceMarkdownFilesAsFacts } from '../core/scan-fact-ingest'
import type { RunCollector } from '../core/telemetry'
import { TokenCountingProvider, estimateCost } from '../core/telemetry'
import type { LLMProvider, LLMStructuredJsonRequest } from '../core/types'
import { loadPromptParts } from '../prompts/loader'
import type { WriteDocumentInput } from '../tools/document-writer'
import { DuckGraphWriter } from '../tools/duck-graph-writer'
import { extractGraphBatch } from '../tools/graph-entity-extractor'
import {
  type RunRescanApplyOrchestratorResult,
  runRescanApplyOrchestrator,
} from '../tools/rescan-apply-orchestrator'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { ensureOperationalBaseDir, getKbHomeDir, readBaseConfig } from './base-selection'
import { CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE } from './cli-prerequisites'
import { readKnowledgeGraphInitSummary } from './graph-cli'
import {
  INIT_SOURCE_SNAPSHOT_MAX_FILES,
  appendFrozenSourceSnapshots,
  buildFrozenSourceSnapshotDoc,
  isInitReadmeHomePath,
} from './init-source-snapshots'
import {
  INIT_TOPIC_DEFINITIONS,
  assessTopicCoverage,
  buildTopicCoverageGaps,
  getTopicDefinition,
  inferTopicFromQuestion,
  markUnaskedTopicsAsInferred,
  summariseCoverage,
} from './init-topic-coverage'
import { createLLMProviderFromConfig, readKbConfig, resolveGraphEnabled } from './kb-config'
import { runLLMSetupWizard } from './llm-setup-wizard'

export type InitCycle =
  | 'read-inputs'
  | 'scan-facts'
  | 'pass1'
  | 'pass2'
  | 'pass-enrich'
  | 'pass3'
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
  dryRun?: boolean
  rescanStageTimeoutMs?: number
  rescanMaxClaims?: number
  rescanMaxEvidenceDocs?: number
  rescanMaxMutations?: number
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

const MAX_SOURCE_SIZE = 20_000
const MAX_TOTAL_QUESTIONS = 10
const MAX_FOLLOW_UP_QUESTIONS = 4
const INIT_MODEL_MAX_TOKENS = 32768
const INIT_PROMPT_SAFETY_TOKENS = 256
const INIT_OUTPUT_TOKENS = {
  synthesisPerTopic: 1200,
  refinement: 1000,
  quality: 900,
  enrich: 700,
} as const

export function parseInitCommand(args: string[]): InitOptions {
  const base = readOption(args, '--base') ?? undefined

  const dryRun = readFlag(args, '--dry-run')

  const stopAfter = readOption(args, '--stop-after') as InitCycle | undefined
  const validCycles: InitCycle[] = [
    'read-inputs',
    'scan-facts',
    'pass1',
    'pass2',
    'pass-enrich',
    'pass3',
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
  if (dryRun && !rescan) {
    throw new Error('Invalid flags: --dry-run is currently supported only with --rescan.')
  }
  if (dryRun && apply) {
    throw new Error('Invalid flags: --dry-run cannot be combined with --apply.')
  }

  const rescanStageTimeoutMs = parseOptionalPositiveInt(
    readOption(args, '--rescan-stage-timeout-ms')
  )
  const rescanMaxClaims = parseOptionalPositiveInt(readOption(args, '--rescan-max-claims'))
  const rescanMaxEvidenceDocs = parseOptionalPositiveInt(
    readOption(args, '--rescan-max-evidence-docs')
  )
  const rescanMaxMutations = parseOptionalPositiveInt(readOption(args, '--rescan-max-mutations'))

  return {
    base,
    nonInteractive: readFlag(args, '--non-interactive'),
    rescan,
    apply,
    dryRun,
    rescanStageTimeoutMs,
    rescanMaxClaims,
    rescanMaxEvidenceDocs,
    rescanMaxMutations,
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
  const checkpointFile = await resolveCheckpointPath({ ...options, base }, cwd)
  const resumedCheckpoint = options.rescan ? undefined : await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(8, options.progressSink)
  const emitInitAction = (label: string, detail: string) => {
    options.progressSink?.(`[init:action] ${label} — ${detail}\n`)
  }
  let rawProvider = options.provider ?? (await resolveProvider())
  let counter =
    rawProvider && options.collector ? new TokenCountingProvider(rawProvider) : undefined
  let provider = counter ?? rawProvider
  const kbConfig = await readKbConfig()
  const graphEnabled = resolveGraphEnabled(kbConfig)

  let checkpoint: InitCheckpoint = resumedCheckpoint ?? {
    version: 2,
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

    if (!checkpoint.completedCycles.includes('scan-facts')) {
      progress.start('scan-facts', 'indexing source sentences into facts…')
      const endScanFacts = makeCycleTimer('scan-facts', provider, options.collector, counter)
      const scanStats = ingestSourceMarkdownFilesAsFacts({
        baseDir,
        files: context.sourceFiles,
      })
      endScanFacts()
      await persist({
        completedCycles: ['scan-facts'],
      })
      progress.finish(
        'scan-facts',
        `${scanStats.segmentsUpserted} segments from ${scanStats.filesScanned} files${
          scanStats.segmentsSkippedShort > 0 ? ` (${scanStats.segmentsSkippedShort} too short)` : ''
        }`
      )
      if (options.stopAfter === 'scan-facts') throw new InitPausedError('scan-facts')
    } else {
      progress.finish('scan-facts', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('pass1')) {
      progress.start('pass1', 'drafting docs + coverage…')
      if (!provider) {
        if (!options.nonInteractive && process.stdin.isTTY) {
          console.log("\n⚙️  No LLM provider configured. Let's set one up before running kb init.\n")
          const wizardResult = await runLLMSetupWizard()
          if (!wizardResult.configured) {
            throw new Error(
              'LLM setup incomplete. Set the required environment variable and re-run `kb init`.'
            )
          }
          // Re-resolve provider after wizard (e.g. ollama chosen — no key needed)
          rawProvider = await resolveProvider()
          counter =
            rawProvider && options.collector ? new TokenCountingProvider(rawProvider) : undefined
          provider = counter ?? rawProvider
          if (!provider) {
            throw new Error(
              'Provider configuration saved. Please restart kb to apply your LLM settings.'
            )
          }
        } else {
          throw new Error(
            'No LLM provider configured.\n\n' +
              'Set one of the following environment variables:\n' +
              '  export ANTHROPIC_API_KEY=<your-key>\n' +
              '  export OPENAI_API_KEY=<your-key>\n' +
              '  export GEMINI_API_KEY=<your-key>\n\n' +
              'Or run `kb config llm` to configure interactively.'
          )
        }
      }
      const endPass1 = makeCycleTimer('pass1', provider, options.collector, counter)
      candidateDocs = await runSynthesisPass(provider, context, base)
      candidateDocs = materializeInitSourceCorpus(candidateDocs, context, base)
      endPass1()
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
      candidateDocs = materializeInitSourceCorpus(candidateDocs, context, base)
      progress.start('pass2', 'follow-up + refining docs…')

      if (!options.nonInteractive && !options.rescan) {
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
            maxQuestions: Math.min(
              remainingQuestionBudget(interviewRounds),
              MAX_FOLLOW_UP_QUESTIONS
            ),
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
      const endPass2 = makeCycleTimer('pass2', provider, options.collector, counter)
      emitInitAction('pass2', 'normalize docs')
      emitInitAction('pass2', 'split multi-topic docs')
      emitInitAction('pass2', 'merge likely duplicates')
      emitInitAction('pass2', 'enforce schema + coverage placeholders')
      candidateDocs = await runRefinementPass(provider, context, candidateDocs)
      endPass2()
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

    if (!candidateDocs) throw new Error('pass2 candidateDocs missing')

    if (!checkpoint.completedCycles.includes('pass-enrich')) {
      progress.start('pass-enrich', `enriching ${candidateDocs.length} docs…`)
      if (!provider) throw new Error('No LLM provider available.')
      const endPassEnrich = makeCycleTimer('pass-enrich', provider, options.collector, counter)
      candidateDocs = await runPerDocEnrichmentPass(provider, context, candidateDocs)
      endPassEnrich()
      await persist({
        candidateDocs,
        completedCycles: ['pass-enrich'],
      })
      progress.finish('pass-enrich', `${candidateDocs.length} docs enriched`)
      if (options.stopAfter === 'pass-enrich') throw new InitPausedError('pass-enrich')
    } else {
      progress.finish('pass-enrich', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('pass3')) {
      progress.start('pass3', 'quality pass…')
      if (!provider) throw new Error('No LLM provider available.')
      const endPass3 = makeCycleTimer('pass3', provider, options.collector, counter)
      emitInitAction('pass3', 'dedup lines + docs')
      emitInitAction('pass3', 'enforce min content + unique titles')
      emitInitAction('pass3', 'final schema normalization')
      candidateDocs = await runQualityPass(provider, candidateDocs)
      endPass3()
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

    let writtenDocIds: string[] | undefined
    if (!checkpoint.completedCycles.includes('write')) {
      progress.start('write', baseDir)
      if (options.rescan) {
        const planResult = await runRescanApplyOrchestrator({
          base,
          baseDir,
          cwd,
          dryRun: true,
          sourceFiles: context.sourceFiles,
          candidateDocs,
          stageTimeoutMs: options.rescanStageTimeoutMs,
          maxClaims: options.rescanMaxClaims,
          maxEvidenceDocs: options.rescanMaxEvidenceDocs,
          maxMutations: options.rescanMaxMutations,
        })
        writtenDocIds = []
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
            dryRun: false,
            sourceFiles: context.sourceFiles,
            candidateDocs,
            stageTimeoutMs: options.rescanStageTimeoutMs,
            maxClaims: options.rescanMaxClaims,
            maxEvidenceDocs: options.rescanMaxEvidenceDocs,
            maxMutations: options.rescanMaxMutations,
          })
          writtenDocIds = applyResult.writtenDocIds
          questionIO.write?.(
            `[kb init] rescan apply: ${applyResult.plan.apply.appliedMutations} actions applied (${applyResult.plan.apply.noopMutations} noop).\n`
          )
        } else {
          questionIO.write?.('[kb init] rescan apply canceled by user; no mutations executed.\n')
        }
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
      if (options.dryRun || (options.rescan && options.apply !== true)) {
        graphPassOutcome = 'dry-run'
        progress.finish('pass-graph', 'skipped (dry-run)')
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
          progress.finish('pass-graph', 'graph written to .kb-graph.duckdb')
        } catch (err) {
          // Graph extraction failed. The DuckDB transaction was rolled back, so
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

  const addSourceFile = async (relativePath: string): Promise<void> => {
    const fullPath = path.join(cwd, relativePath)
    if (!existsSync(fullPath)) return
    const normalizedKey = relativePath.replace(/\\/g, '/').toLowerCase()
    if (seenPaths.has(normalizedKey)) return
    const content = await readFile(fullPath, 'utf8')
    sourceFiles[relativePath] = content.slice(0, MAX_SOURCE_SIZE)
    seenPaths.add(normalizedKey)
  }

  for (const candidate of SOURCE_FILE_CANDIDATES) {
    await addSourceFile(candidate)
  }

  try {
    const topLevel = await readdir(cwd)
    for (const file of topLevel) {
      if (
        !file.endsWith('.md') ||
        sourceFiles[file] ||
        seenPaths.has(file.toLowerCase()) ||
        Object.keys(sourceFiles).length >= 8
      )
        continue
      await addSourceFile(file)
    }
  } catch {
    // Ignore directory listing failures.
  }

  return sourceFiles
}

const README_PATH_PATTERN = /(^|\/)readme\.(md|markdown|txt)$/i

async function collectRescanSourceFiles(options: {
  cwd: string
  baseDir: string
  baseName: string
  questionIO: InitQuestionIO
}): Promise<Record<string, string>> {
  const allSourceFiles = await collectSourceFiles(options.cwd)
  const readmeEntries = Object.entries(allSourceFiles).filter(([filePath]) =>
    README_PATH_PATTERN.test(filePath.replace(/\\/g, '/'))
  )

  if (readmeEntries.length === 0) {
    options.questionIO.write?.(
      '[kb init] --rescan found no README-like files; continuing with an empty source delta.\n'
    )
    return {}
  }

  const unchangedFingerprints = readRescanSnapshotFingerprints(options.baseDir)
  if (unchangedFingerprints.size === 0) {
    options.questionIO.write?.(
      `[kb init] --rescan found no prior source snapshots for "${options.baseName}"; treating ${readmeEntries.length} README file(s) as new.\n`
    )
    return Object.fromEntries(readmeEntries)
  }

  const changedOrNew = readmeEntries.filter(([filePath, body]) => {
    const snapshot = buildFrozenSourceSnapshotDoc(
      filePath,
      body,
      options.baseName,
      'collected-on-init'
    )
    const fingerprint = `${snapshot.title}\u0000${snapshot.content.trimEnd()}`
    return !unchangedFingerprints.has(fingerprint)
  })
  options.questionIO.write?.(
    `[kb init] --rescan picked ${changedOrNew.length}/${readmeEntries.length} changed/new README file(s).\n`
  )
  return Object.fromEntries(changedOrNew)
}

function readRescanSnapshotFingerprints(baseDir: string): Set<string> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  if (!existsSync(dbPath)) return new Set()
  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    const fingerprints = new Set<string>()
    for (const row of indexer.getAllDocumentsForLexical()) {
      if (row.is_original !== 1) continue
      if (!row.tags_json?.includes('source-excerpt')) continue
      fingerprints.add(`${row.title}\u0000${extractStoredDocumentBody(row.content)}`)
    }
    return fingerprints
  } finally {
    indexer.close()
  }
}

function extractStoredDocumentBody(content: string): string {
  const sections = content.split('\n\n')
  if (sections.length < 3) return content.trimEnd()
  return sections.slice(2).join('\n\n').trimEnd()
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
    options.existingRounds.flatMap(round =>
      round.questions.map(question => `${question.topic}:${question.reason}`)
    )
  )

  const candidates = buildTopicCoverageGaps(options.topicCoverage)
    .filter(topic => !alreadyAskedTopics.has(`${topic.topic}:${topic.reason}`))
    .slice(0, options.maxQuestions)

  return candidates.map(topic => {
    const definition = getTopicDefinition(topic.topic)
    return buildInterviewQuestion(
      topic.topic,
      definition.followUpQuestion,
      options.round,
      topic.reason
    )
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

function titleFromTopicSlug(slug: string): string {
  return slug
    .split('-')
    .map(part => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function synthesisPlaceholderDoc(
  def: (typeof INIT_TOPIC_DEFINITIONS)[number],
  baseName: string
): CandidateDoc {
  return {
    title: titleFromTopicSlug(def.topic),
    type: 'reference',
    tags: [def.topic, baseName],
    isOriginal: false,
    content: [
      'Pass1 did not return valid JSON for this topic.',
      '',
      `**Focus:** ${def.initialQuestion}`,
      '',
      'Re-run `kb init` or pull facts manually from the repository sources.',
    ].join('\n'),
  }
}

async function runSynthesisPass(
  provider: LLMProvider,
  context: InitContext,
  baseName: string
): Promise<CandidateDoc[]> {
  const synthesisParts = loadPromptParts('init-synthesis.md')
  const perTopicMax = clampInitOutputTokens(INIT_OUTPUT_TOKENS.synthesisPerTopic)

  const sectionsTemplate = [
    {
      heading: 'Documentation Files',
      content: formatSourceFilesForPrompt(context.sourceFiles),
      priority: 3,
      minTokens: 500,
    },
    {
      heading: 'Source Code Index',
      content: formatCodeFilesForPrompt(context.codeFiles),
      priority: 2,
      minTokens: 300,
    },
    {
      heading: 'User Q&A',
      content: formatQuestionAnswersForPrompt(context.userAnswers, '(No Q&A collected)'),
      priority: 1,
      minTokens: 120,
    },
  ] as const

  const topicResults = await Promise.all(
    INIT_TOPIC_DEFINITIONS.map(async def => {
      const topicQuestion = `**${def.topic}** — ${def.initialQuestion}`
      const intro = synthesisParts.intro
        .replace(/\{\{baseName\}\}/g, baseName)
        .replace(/\{\{topicQuestion\}\}/g, topicQuestion)

      const { prompt, maxTokens } = buildBudgetedPrompt({
        intro,
        sections: [...sectionsTemplate],
        instructions: synthesisParts.instructions,
        requestedMaxTokens: perTopicMax,
      })

      const structuredJson: LLMStructuredJsonRequest | undefined =
        provider.name === 'openai'
          ? {
              openai: {
                name: 'init_synthesis_doc',
                schema: INIT_SYNTHESIS_OPENAI_JSON_SCHEMA,
              },
            }
          : provider.name === 'gemini'
            ? { gemini: INIT_SYNTHESIS_GEMINI_RESPONSE_SCHEMA }
            : undefined

      const response = await provider.call({
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature: 0.2,
        ...(provider.name === 'gemini' ? { thinkingBudget: 0 } : {}),
        ...(structuredJson ? { structuredJson } : {}),
      })

      const parsed = parseInitSynthesisObject(response.text)
      if (!parsed) {
        return {
          succeeded: false,
          doc: synthesisPlaceholderDoc(def, baseName),
        }
      }
      const tags = [...new Set([...(parsed.tags ?? []), def.topic])]
      return {
        succeeded: true,
        doc: { ...parsed, tags, isOriginal: false } satisfies CandidateDoc,
      }
    })
  )

  if (!topicResults.some(r => r.succeeded)) {
    return normalizeInitDocs(
      INIT_TOPIC_DEFINITIONS.map(def => synthesisPlaceholderDoc(def, baseName))
    )
  }

  return normalizeInitDocs(topicResults.map(r => ({ ...r.doc, isOriginal: false })))
}

async function runRefinementPass(
  _provider: LLMProvider,
  context: InitContext,
  docs: CandidateDoc[]
): Promise<CandidateDoc[]> {
  const next = runDeterministicRefinementPass(docs, context)
  return normalizeInitDocs(preventInitDocCollapse(docs, next), {
    fallback: docs,
    preserveMinimumCount: docs.length,
  })
}

async function runQualityPass(
  _provider: LLMProvider,
  docs: CandidateDoc[]
): Promise<CandidateDoc[]> {
  const next = runDeterministicQualityPass(docs)
  return normalizeInitDocs(preventInitDocCollapse(docs, next), {
    fallback: docs,
    preserveMinimumCount: docs.length,
    minWords: 20,
  })
}

/**
 * Pass-enrich: each candidate doc gets a dedicated LLM pass to deepen its
 * coverage, add concrete detail, and remove internal redundancy.
 * Docs are processed in parallel since they are independent.
 */
async function runPerDocEnrichmentPass(
  provider: LLMProvider,
  context: InitContext,
  docs: CandidateDoc[]
): Promise<CandidateDoc[]> {
  const enriched = await Promise.all(
    docs.map(async (doc): Promise<CandidateDoc> => {
      const enrichmentParts = loadPromptParts('init-enrichment.md')
      const { prompt, maxTokens } = buildBudgetedPrompt({
        intro: enrichmentParts.intro,
        sections: [
          {
            heading: 'Document',
            content: formatDocsForPrompt([doc], 1400),
            priority: 2,
            minTokens: 180,
          },
          {
            heading: 'Available source context',
            content: formatSourceFilesForPrompt(context.sourceFiles, 2200),
            priority: 2,
            minTokens: 280,
          },
          {
            heading: 'Source code index',
            content: formatCodeFilesForPrompt(context.codeFiles),
            priority: 1,
            minTokens: 150,
          },
          {
            heading: 'User Q&A',
            content: formatQuestionAnswersForPrompt(context.userAnswers, '(none)'),
            priority: 1,
            minTokens: 100,
          },
        ],
        instructions: enrichmentParts.instructions,
        requestedMaxTokens: INIT_OUTPUT_TOKENS.enrich,
      })

      const response = await provider.call({
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature: 0.15,
      })

      const match = response.text.match(/\{[\s\S]*\}/)
      if (!match) return doc
      try {
        const parsed = JSON.parse(match[0]) as Partial<CandidateDoc>
        if (typeof parsed.title === 'string' && typeof parsed.content === 'string') {
          return { ...doc, ...parsed }
        }
      } catch {
        // fall through
      }
      return doc
    })
  )

  return normalizeInitDocs(enriched, {
    fallback: docs,
    preserveMinimumCount: docs.length,
  })
}

type GraphPassOutcome = 'extracted' | 'disabled' | 'dry-run' | 'failed' | 'no-provider' | 'reused'

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
    if (options.graphPassOutcome === 'dry-run') {
      write(`${banner}Knowledge graph: skipped (dry-run mode).\n`)
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

  const graphPath = DuckGraphWriter.dbPathForBase(baseDir)
  const writer = new DuckGraphWriter(graphPath)
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

function buildBudgetedPrompt(options: {
  intro: string
  sections: Array<{
    heading: string
    content: string
    priority: number
    minTokens?: number
  }>
  instructions: string
  requestedMaxTokens: number
}): { prompt: string; maxTokens: number } {
  const maxTokens = clampInitOutputTokens(options.requestedMaxTokens)
  const inputBudget = Math.max(INIT_MODEL_MAX_TOKENS - maxTokens - INIT_PROMPT_SAFETY_TOKENS, 400)

  const header = options.intro.trim()
  const instructions = `## Instructions\n${options.instructions.trim()}`
  const sectionHeaders = options.sections.map(section => `## ${section.heading}`)
  const fixedTokens = approximateTokenCount([header, ...sectionHeaders, instructions].join('\n\n'))

  const contentBudget = Math.max(inputBudget - fixedTokens, 200)
  const totalPriority = options.sections.reduce(
    (sum, section) => sum + Math.max(section.priority, 1),
    0
  )

  const initialBudgets = options.sections.map(section => {
    const weightedBudget = Math.floor(
      (contentBudget * Math.max(section.priority, 1)) / Math.max(totalPriority, 1)
    )
    return Math.max(section.minTokens ?? 80, weightedBudget)
  })

  let allocated = initialBudgets.reduce((sum, value) => sum + value, 0)
  if (allocated > contentBudget) {
    let overflow = allocated - contentBudget
    for (let index = initialBudgets.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const floor = options.sections[index].minTokens ?? 80
      const reducible = Math.max(initialBudgets[index] - floor, 0)
      const reduction = Math.min(reducible, overflow)
      initialBudgets[index] -= reduction
      overflow -= reduction
    }
    allocated = initialBudgets.reduce((sum, value) => sum + value, 0)
  }

  const render = (budgets: number[]) =>
    [
      header,
      ...options.sections.map(
        (section, index) =>
          `## ${section.heading}\n${trimToTokenBudget(section.content, budgets[index])}`
      ),
      instructions,
    ].join('\n\n')

  let prompt = render(initialBudgets)
  let promptTokens = approximateTokenCount(prompt)

  if (promptTokens > inputBudget) {
    const budgets = [...initialBudgets]
    let guard = 0
    while (promptTokens > inputBudget && guard < 20) {
      const largestIndex = budgets.reduce(
        (best, budget, index, all) => (budget > all[best] ? index : best),
        0
      )
      const floor = options.sections[largestIndex].minTokens ?? 40
      if (budgets[largestIndex] <= floor) {
        break
      }
      budgets[largestIndex] = Math.max(floor, budgets[largestIndex] - 60)
      prompt = render(budgets)
      promptTokens = approximateTokenCount(prompt)
      guard += 1
    }
  }

  return { prompt, maxTokens }
}

function clampInitOutputTokens(requested: number): number {
  return Math.max(256, Math.min(requested, INIT_MODEL_MAX_TOKENS - INIT_PROMPT_SAFETY_TOKENS))
}

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

function trimToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return ''
  const charBudget = Math.max(tokenBudget * 4, 32)
  if (text.length <= charBudget) return text
  if (charBudget < 80) return `${text.slice(0, charBudget)}…`
  const head = Math.floor(charBudget * 0.75)
  const tail = Math.max(charBudget - head - 24, 0)
  return `${text.slice(0, head)}\n\n…[truncated for token budget]…\n\n${tail > 0 ? text.slice(-tail) : ''}`
}

function formatCodeFilesForPrompt(codeFiles: Record<string, string>): string {
  const entries = Object.entries(codeFiles)
  if (entries.length === 0) return '(No source code collected)'
  // Group by top-level directory for readability
  const byDir = new Map<string, string[]>()
  for (const [file] of entries) {
    const dir = file.includes('/') ? file.split('/')[0] : '(root)'
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir)?.push(file)
  }
  const dirSummary = [...byDir.entries()]
    .map(([dir, files]) => `${dir}/  (${files.length} files)\n  ${files.join('\n  ')}`)
    .join('\n\n')
  return `${entries.length} source files across ${byDir.size} directories:\n\n${dirSummary}`
}

function formatSourceFilesForPrompt(
  sourceFiles: Record<string, string>,
  perFileCharLimit = 3500
): string {
  const entries = Object.entries(sourceFiles)
  if (entries.length === 0) return '(No source files collected)'
  return entries
    .map(
      ([file, content]) =>
        `### ${file}\n${trimToTokenBudget(content, approximateTokenCount(content.slice(0, perFileCharLimit)))}`
    )
    .join('\n\n---\n\n')
}

function formatQuestionAnswersForPrompt(
  userAnswers: InitUserAnswer[],
  emptyFallback: string
): string {
  if (userAnswers.length === 0) return emptyFallback
  return userAnswers
    .map(
      ({ question, answer }) =>
        `Q: ${trimToTokenBudget(question, 80)}\nA: ${trimToTokenBudget(answer, 140)}`
    )
    .join('\n\n')
}

function formatDocsForPrompt(docs: CandidateDoc[], contentCharLimit = 900): string {
  return JSON.stringify(
    docs.map(doc => ({
      ...doc,
      content: trimToTokenBudget(
        doc.content,
        approximateTokenCount(doc.content.slice(0, contentCharLimit))
      ),
    })),
    null,
    2
  )
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

/** Single-doc expansion plus frozen per-file snapshots (idempotent). */
function materializeInitSourceCorpus(
  docs: CandidateDoc[],
  context: InitContext,
  baseName: string
): CandidateDoc[] {
  const expanded = maybeExpandSingleDocCorpus(docs, context, baseName)
  return appendFrozenSourceSnapshots(expanded, context.sourceFiles, baseName)
}

/** When synthesis collapses to one doc but we have several source files, split into overview + per-file reference shards (baseline until a proper grouping pass exists). */
function maybeExpandSingleDocCorpus(
  docs: CandidateDoc[],
  context: InitContext,
  baseName: string
): CandidateDoc[] {
  if (docs.length !== 1) return docs
  const paths = Object.keys(context.sourceFiles).filter(
    key => (context.sourceFiles[key] ?? '').trim().length > 0
  )
  if (paths.length <= 1) return docs
  return expandSingleDocIntoSourceShards(docs[0], context, baseName)
}

function expandSingleDocIntoSourceShards(
  lone: CandidateDoc,
  context: InitContext,
  baseName: string
): CandidateDoc[] {
  const overview: CandidateDoc = {
    title: 'Project Overview',
    type: 'introduction',
    tags: ['overview', baseName],
    content: lone.content,
    isOriginal: false,
  }
  const shards: CandidateDoc[] = []
  for (const filePath of Object.keys(context.sourceFiles).slice(
    0,
    INIT_SOURCE_SNAPSHOT_MAX_FILES
  )) {
    const body = context.sourceFiles[filePath]
    if (typeof body !== 'string' || !body.trim()) continue
    // README is the site homepage — exclude it from original_docs sidebar entries
    if (isInitReadmeHomePath(filePath)) continue
    shards.push(buildFrozenSourceSnapshotDoc(filePath, body, baseName, 'split-from-single'))
  }
  return [overview, ...shards]
}

/** If the LLM returns one document but we had several, keep the prior corpus (refine/quality passes). */
function preventInitDocCollapse(previous: CandidateDoc[], next: CandidateDoc[]): CandidateDoc[] {
  if (previous.length > 1 && next.length === 1) return previous
  return next
}

function runDeterministicRefinementPass(
  docs: CandidateDoc[],
  context: InitContext
): CandidateDoc[] {
  let next = normalizeInitDocs(docs, { fallback: docs })
  next = splitMultiTopicDocs(next)
  next = mergeLikelyDuplicateDocs(next)
  next = appendCoveragePlaceholders(next, context)
  return next
}

function runDeterministicQualityPass(docs: CandidateDoc[]): CandidateDoc[] {
  let next = normalizeInitDocs(docs, { fallback: docs })
  next = dedupWithinDocs(next)
  next = mergeLikelyDuplicateDocs(next)
  next = normalizeInitDocs(next, { fallback: docs, minWords: 20 })
  return next
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

function splitMultiTopicDocs(docs: CandidateDoc[]): CandidateDoc[] {
  const expanded: CandidateDoc[] = []
  for (const doc of docs) {
    const parts = splitDocByHeadings(doc)
    if (parts.length <= 1) {
      expanded.push(doc)
      continue
    }
    expanded.push(...parts)
  }
  return expanded
}

function splitDocByHeadings(doc: CandidateDoc): CandidateDoc[] {
  const lines = doc.content.split('\n')
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^##\s+/.test(line) && current.length > 0) {
      sections.push(current.join('\n').trim())
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n').trim())
  if (sections.length <= 1) return [doc]

  return sections
    .map((content, index) => {
      const heading = content.match(/^##\s+(.+)$/m)?.[1]?.trim()
      return {
        ...doc,
        title: heading ? `${doc.title} - ${heading}` : `${doc.title} Part ${index + 1}`,
        content,
      }
    })
    .filter(section => countWords(section.content) >= 20)
}

function mergeLikelyDuplicateDocs(docs: CandidateDoc[]): CandidateDoc[] {
  const merged: CandidateDoc[] = []
  const used = new Set<number>()

  for (let i = 0; i < docs.length; i++) {
    if (used.has(i)) continue
    let base = docs[i]

    for (let j = i + 1; j < docs.length; j++) {
      if (used.has(j)) continue
      if (!areLikelyDuplicateDocs(base, docs[j])) continue
      base = mergeTwoDocs(base, docs[j])
      used.add(j)
    }

    merged.push(base)
  }

  return merged
}

function areLikelyDuplicateDocs(a: CandidateDoc, b: CandidateDoc): boolean {
  const titleA = normalizeTitleTokenSet(a.title)
  const titleB = normalizeTitleTokenSet(b.title)
  const titleOverlap = overlapRatio(titleA, titleB)
  if (titleOverlap >= 0.75) return true

  const contentA = normalizeContentTokenSet(a.content)
  const contentB = normalizeContentTokenSet(b.content)
  return overlapRatio(contentA, contentB) >= 0.72
}

function mergeTwoDocs(a: CandidateDoc, b: CandidateDoc): CandidateDoc {
  const title = a.title.length <= b.title.length ? a.title : b.title
  const type = a.type === b.type ? a.type : (a.type ?? b.type ?? 'reference')
  const tags = normalizeTags([...(a.tags ?? []), ...(b.tags ?? [])])
  const content = dedupLines(`${a.content}\n${b.content}`)
  return {
    ...a,
    title,
    type,
    tags,
    content,
  }
}

function dedupWithinDocs(docs: CandidateDoc[]): CandidateDoc[] {
  return docs.map(doc => ({
    ...doc,
    content: dedupLines(doc.content),
  }))
}

function dedupLines(content: string): string {
  const seen = new Set<string>()
  const output: string[] = []
  for (const line of content.split('\n')) {
    const key = line.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    output.push(line.trim())
  }
  return output.join('\n').trim()
}

function appendCoveragePlaceholders(docs: CandidateDoc[], context: InitContext): CandidateDoc[] {
  const existingTopics = new Set(docs.flatMap(doc => doc.tags ?? []).map(tag => tag.toLowerCase()))
  const missing = INIT_TOPIC_DEFINITIONS.filter(def => !existingTopics.has(def.topic))
  if (missing.length === 0) return docs

  const placeholders = missing.map(def => ({
    title: titleFromTopicSlug(def.topic),
    type: 'reference' as const,
    tags: [def.topic],
    content: `Coverage gap for topic ${def.topic}. Source evidence currently insufficient in init inputs.`,
    isOriginal: false,
  }))

  if (context.userAnswers.length === 0 && docs.length > 0) return docs
  return [...docs, ...placeholders]
}

function normalizeTitleTokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2)
  )
}

function normalizeContentTokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 4)
  )
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  for (const item of left) {
    if (right.has(item)) overlap += 1
  }
  return overlap / Math.max(Math.min(left.size, right.size), 1)
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

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`)
  }
  return parsed
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
