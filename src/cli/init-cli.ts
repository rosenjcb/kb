/**
 * kb init — knowledge base bootstrap command.
 *
 * Cycle 1 (read-inputs):     Discover README/CLAUDE.md in working dir,
 *                             ask an initial interview round via stdin.
 * Cycle 2 (pass1):           Draft 5-15 candidate docs from source files + Q&A.
 * Cycle 3 (pass2):           Follow-up questions for weak topics, LLM refinement.
 * Cycle 4 (pass-enrich):     Per-document enrichment — each doc gets a dedicated
 *                             LLM pass to deepen coverage and add concrete detail.
 * Cycle 5 (pass-consolidate):Consolidation agent — (currently disabled) merges overlapping docs.
 * Cycle 6 (pass3):           Final quality pass — validate, dedupe, remove stubs.
 * Cycle 7 (write):           Upsert all candidate documents to SQLite.
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { loadPromptParts } from '../prompts/loader'
import path from 'node:path'
import readline from 'node:readline'
import dayjs from 'dayjs'
import type { RunCollector } from '../core/telemetry'
import { TokenCountingProvider, estimateCost } from '../core/telemetry'
import type { LLMProvider } from '../core/types'
import type { WriteDocumentInput } from '../tools/document-writer'
import { basenameTitle } from '../core/string-utils'
import { DuckGraphWriter } from '../tools/duck-graph-writer'
import { extractGraphBatch } from '../tools/graph-entity-extractor'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { ensureOperationalBaseDir, getKbHomeDir, readBaseConfig } from './base-selection'
import { CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE } from './cli-prerequisites'
import {
  INIT_TOPIC_DEFINITIONS,
  assessTopicCoverage,
  buildTopicCoverageGaps,
  getTopicDefinition,
  inferTopicFromQuestion,
  markUnaskedTopicsAsInferred,
  summariseCoverage,
} from './init-topic-coverage'
import { readKnowledgeGraphInitSummary } from './graph-cli'
import { createLLMProviderFromConfig, readKbConfig, resolveGraphEnabled } from './kb-config'
import { runLLMSetupWizard } from './llm-setup-wizard'

// pass-consolidate is temporarily disabled — too aggressive; needs smarter merge strategy before re-enabling
export type InitCycle =
  | 'read-inputs'
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
  synthesis: 3000,
  refinement: 1000,
  quality: 900,
  enrich: 700,
  consolidate: 1200,
} as const

export function parseInitCommand(args: string[]): InitOptions {
  const base = readOption(args, '--base') ?? undefined

  const hasDryRun = readFlag(args, '--dry-run')
  if (hasDryRun) {
    throw new Error(
      'Unsupported init flag. Use `--stop-after <cycle>`, `--detach`, or `--resume` to control the lifecycle.'
    )
  }

  const stopAfter = readOption(args, '--stop-after') as InitCycle | undefined
  const validCycles: InitCycle[] = [
    'read-inputs',
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

  return {
    base,
    nonInteractive: readFlag(args, '--non-interactive'),
    detach: readFlag(args, '--detach'),
    resume: readFlag(args, '--resume'),
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
  const resumedCheckpoint = await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(8, options.progressSink)
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
      candidateDocs = maybeExpandSingleDocCorpus(candidateDocs, context, base)
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
      candidateDocs = maybeExpandSingleDocCorpus(candidateDocs, context, base)
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

    // pass-consolidate is disabled — the LLM-driven merge was too aggressive and dropped content.
    // TODO: re-enable with improved merge strategy (similarity threshold + human review step).
    // if (!checkpoint.completedCycles.includes('pass-consolidate')) {
    //   progress.start('pass-consolidate', 'merging overlapping docs…')
    //   if (!provider) throw new Error('No LLM provider available.')
    //   const beforeCount = candidateDocs.length
    //   const endPassConsolidate = makeCycleTimer('pass-consolidate', provider, options.collector, counter)
    //   candidateDocs = await runConsolidationPass(provider, candidateDocs)
    //   endPassConsolidate()
    //   await persist({ candidateDocs, completedCycles: ['pass-consolidate'] })
    //   const merged = beforeCount - candidateDocs.length
    //   progress.finish('pass-consolidate', merged > 0 ? `${merged} docs merged → ${candidateDocs.length} total` : `no merges needed, ${candidateDocs.length} docs`)
    //   if (options.stopAfter === 'pass-consolidate') throw new InitPausedError('pass-consolidate')
    // } else {
    //   progress.finish('pass-consolidate', 'reused from checkpoint')
    // }

    if (!checkpoint.completedCycles.includes('pass3')) {
      progress.start('pass3', 'quality pass…')
      if (!provider) throw new Error('No LLM provider available.')
      const endPass3 = makeCycleTimer('pass3', provider, options.collector, counter)
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
      writtenDocIds = await writeDocs(candidateDocs, baseDir, base)
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
    if (!checkpoint.completedCycles.includes('pass-graph')) {
      progress.start('pass-graph', 'extracting knowledge graph…')
      if (!graphEnabled) {
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
        } catch {
          // Graph extraction failure must not abort a successful init
          graphPassOutcome = 'error'
          progress.finish('pass-graph', 'skipped (error)')
          await persist({ completedCycles: ['pass-graph'] })
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
  const codeFiles = await crawlSourceCode(options.cwd)
  const context: InitContext = {
    sourceFiles,
    codeFiles,
    userAnswers: [],
  }

  if (options.nonInteractive) {
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

  for (const candidate of SOURCE_FILE_CANDIDATES) {
    const fullPath = path.join(cwd, candidate)
    if (!existsSync(fullPath)) continue
    const content = await readFile(fullPath, 'utf8')
    sourceFiles[candidate] = content.slice(0, MAX_SOURCE_SIZE)
  }

  try {
    const topLevel = await readdir(cwd)
    for (const file of topLevel) {
      if (!file.endsWith('.md') || sourceFiles[file] || Object.keys(sourceFiles).length >= 8)
        continue
      const content = await readFile(path.join(cwd, file), 'utf8')
      sourceFiles[file] = content.slice(0, MAX_SOURCE_SIZE)
    }
  } catch {
    // Ignore directory listing failures.
  }

  return sourceFiles
}

export const SOURCE_CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rb', '.java', '.rs', '.swift', '.kt']
export const SOURCE_CODE_EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '_site', '.git', 'vendor', 'coverage', '.next', 'out', '.cache', '__pycache__', '.turbo'])
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

async function runSynthesisPass(
  provider: LLMProvider,
  context: InitContext,
  baseName: string
): Promise<CandidateDoc[]> {
  const synthesisParts = loadPromptParts('init-synthesis.md')
  const topicList = INIT_TOPIC_DEFINITIONS.map(
    d => `- **${d.topic}**: ${d.initialQuestion}`
  ).join('\n')
  const { prompt, maxTokens } = buildBudgetedPrompt({
    intro: synthesisParts.intro
      .replace('{{baseName}}', baseName)
      .replace('{{topicList}}', topicList),
    sections: [
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
    ],
    instructions: synthesisParts.instructions,
    requestedMaxTokens: INIT_OUTPUT_TOKENS.synthesis,
  })

  const response = await provider.call({
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature: 0.2,
  })

  return parseDocArray(response.text) ?? fallbackDocs(context, baseName)
}

async function runRefinementPass(
  provider: LLMProvider,
  context: InitContext,
  docs: CandidateDoc[]
): Promise<CandidateDoc[]> {
  const refinementParts = loadPromptParts('init-refinement.md')
  const { prompt, maxTokens } = buildBudgetedPrompt({
    intro: refinementParts.intro,
    sections: [
      {
        heading: 'Current documents',
        content: formatDocsForPrompt(docs),
        priority: 3,
        minTokens: 500,
      },
      {
        heading: 'Additional user context',
        content: formatQuestionAnswersForPrompt(context.userAnswers, '(none)'),
        priority: 1,
        minTokens: 100,
      },
    ],
    instructions: refinementParts.instructions,
    requestedMaxTokens: INIT_OUTPUT_TOKENS.refinement,
  })

  const response = await provider.call({
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature: 0.1,
  })

  const parsed = parseDocArray(response.text)
  const next = parsed ?? docs
  return preventInitDocCollapse(docs, next)
}

async function runQualityPass(
  provider: LLMProvider,
  docs: CandidateDoc[]
): Promise<CandidateDoc[]> {
  const qualityParts = loadPromptParts('init-quality.md')
  const { prompt, maxTokens } = buildBudgetedPrompt({
    intro: qualityParts.intro,
    sections: [
      {
        heading: 'Documents',
        content: formatDocsForPrompt(docs),
        priority: 1,
        minTokens: 600,
      },
    ],
    instructions: qualityParts.instructions,
    requestedMaxTokens: INIT_OUTPUT_TOKENS.quality,
  })

  const response = await provider.call({
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature: 0.0,
  })

  const parsed = parseDocArray(response.text)
  const next = parsed ?? docs
  return preventInitDocCollapse(docs, next)
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

  return enriched
}

// runConsolidationPass is disabled — too aggressive, drops content under LLM merge.
// TODO: re-enable with improved merge strategy (similarity threshold + human review step).
// async function runConsolidationPass(
//   provider: LLMProvider,
//   docs: CandidateDoc[],
// ): Promise<CandidateDoc[]> {
//   const { prompt, maxTokens } = buildBudgetedPrompt({
//     intro: `You are a knowledge base architect doing a consolidation pass.
// Review all documents for content overlap and merge where appropriate.`,
//     sections: [{ heading: 'Documents', content: formatDocsForPrompt(docs, 1000), priority: 1, minTokens: 700 }],
//     instructions: `1. Identify pairs (or groups) of documents that cover the same or very similar topic...
// Return the consolidated set as a JSON array in the same shape (title, type, tags, content).
// Return ONLY the JSON array, no prose.`,
//     requestedMaxTokens: INIT_OUTPUT_TOKENS.consolidate,
//   })
//   const response = await provider.call({ messages: [{ role: 'user', content: prompt }], maxTokens, temperature: 0.1 })
//   return parseDocArray(response.text) ?? docs
// }

type GraphPassOutcome = 'extracted' | 'disabled' | 'error' | 'no-provider' | 'reused'

async function emitPostInitGraphOverview(options: {
  baseDir: string
  graphPassOutcome: GraphPassOutcome
  questionIO: InitQuestionIO
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
    if (options.graphPassOutcome === 'no-provider') {
      write(`${banner}Knowledge graph: skipped (no LLM provider for extraction).\n`)
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
    if (entities.length > 0) await writer.upsertEntities(entities)
    if (relationships.length > 0) await writer.upsertRelationships(relationships)
  } finally {
    writer.close()
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
        typeof (item as CandidateDoc).content === 'string'
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

  return [
    {
      title: `${baseName} project overview`,
      type: 'architecture',
      tags: ['overview', baseName],
      content: `# ${baseName} project overview\n\nAuto-generated from project documentation.\n\n${content}\n\n${qaContent}`,
    },
  ]
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
  if (configured.selectedBase?.trim()) {
    return configured.selectedBase.trim()
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

/** When synthesis collapses to one doc but we have several source files, split into overview + per-file reference shards (baseline until a proper grouping pass exists). */
const INIT_SOURCE_SHARD_MAX_FILES = 12
const INIT_SOURCE_SHARD_MAX_CHARS = 8000

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
    type: 'architecture',
    tags: ['overview', baseName],
    content: lone.content,
  }
  const shards: CandidateDoc[] = []
  for (const filePath of Object.keys(context.sourceFiles).slice(0, INIT_SOURCE_SHARD_MAX_FILES)) {
    const body = context.sourceFiles[filePath]
    if (typeof body !== 'string' || !body.trim()) continue
    const safeName = filePath.replace(/\\/g, '/')
    // README is the site homepage — exclude it from original_docs sidebar entries
    if (/^readme\.md$/i.test(safeName.split('/').pop() ?? '')) continue
    const humanTitle = basenameTitle(safeName)
    const clipped = body.slice(0, INIT_SOURCE_SHARD_MAX_CHARS)
    const tail = body.length > INIT_SOURCE_SHARD_MAX_CHARS ? '\n\n…(truncated during init split)…' : ''
    shards.push({
      title: humanTitle,
      type: 'reference',
      tags: ['source-excerpt', slugify(safeName), baseName],
      content: `# ${humanTitle}\n\nRepository excerpt captured during init (split from a single synthesis document).\n\n${clipped}${tail}\n`,
      isOriginal: true,
    })
  }
  return [overview, ...shards]
}

/** If the LLM returns one document but we had several, keep the prior corpus (refine/quality passes). */
function preventInitDocCollapse(previous: CandidateDoc[], next: CandidateDoc[]): CandidateDoc[] {
  if (previous.length > 1 && next.length === 1) return previous
  return next
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
  const legacyCheckpointPath = path.join(
    cwd,
    '.tmp',
    'kb-init',
    `${slugify(base)}-latest.checkpoint.json`
  )
  if (!(await pathExists(checkpointPath))) {
    await mkdir(path.dirname(checkpointPath), { recursive: true })
    if (await pathExists(legacyCheckpointPath)) {
      await writeFile(checkpointPath, await readFile(legacyCheckpointPath, 'utf8'), 'utf8')
    }
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

function dedup<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

class InitPausedError extends Error {
  constructor(readonly cycle: InitCycle) {
    super(`Init paused after ${cycle}`)
  }
}
