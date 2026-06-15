/**
 * kb init / kb scan — knowledge base bootstrap and refresh commands.
 *
 * Cycle 1 (read-inputs):    Discover markdown sources under working dir (recursive).
 * Cycle 2 (code-index):     Deterministic AST indexing (ts-morph for TS/JS, tree-sitter for Go/other)
 *                            → facts table (symbols, imports, structural edges).
 * Cycle 3 (document-facts): Deterministic sentence segmentation of source markdown → `facts` table.
 * Cycle 4 (import-docs):    One `is_original` SQLite doc per collected markdown file (verbatim body).
 * Cycle 5 (write):          Upsert documents.
 *
 * Reuses progress reporting and checkpoint patterns from publish-cli.ts.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { type GitRepoMeta, repoDirForSlug, repoSlugFromGitUrl, writeBaseMeta } from './base-meta'
import { cloneRepo, getHeadSha } from './git-sync'
import { TsMorphIndexer, tombstoneStaleAstFacts } from '../tools/code-graph-indexer'
import {
  isTreeSitterIndexablePath,
  TreeSitterIndexer,
  TREE_SITTER_SKIP_DIRS,
} from '../tools/tree-sitter-indexer'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import dayjs from 'dayjs'
import { DOC_TYPES } from '../core/doc-taxonomy'
import { tombstoneRemovedDocSourceFiles } from '../core/doc-fact-writer'
import { ingestIntegrationSignals } from '../core/integration-ingest'
import {
  ingestSourceMarkdownFilesAsFacts,
  type ScanFactIngestProgress,
} from '../core/scan-fact-ingest'
import type { RunCollector } from '../core/telemetry'
import { TokenCountingProvider, estimateCost } from '../core/telemetry'
import type { LLMProvider } from '../core/types'
import type { WriteDocumentInput } from '../tools/document-writer'
import {
  runRescanApplyOrchestrator,
  type RescanApplyOrchestratorProgress,
} from '../tools/rescan-apply-orchestrator'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import {
  ensureOperationalBaseDir,
  findKbFile,
  getKbHomeDir,
  listAllBases,
  writeKbFile,
  writeSessionBase,
} from './base-selection'
import { CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE } from './cli-prerequisites'
import {
  buildSourceFileHashes,
  diffChangedSourceFiles,
  readSourceFilesManifest,
  writeSourceFilesManifest,
} from './init-source-files-manifest'
import {
  diffChangedAstFiles,
  readAstFilesManifest,
  writeAstFilesManifest,
} from './init-ast-files-manifest'
import {
  assessTopicCoverage,
  summariseCoverage,
} from './init-topic-coverage'
import { createLLMProviderFromConfig, readKbConfig } from './kb-config'
import type { SlashInputContext } from '../tui/slash-command-registry.js'

export type InitCycle =
  | 'read-inputs'
  | 'code-index'
  | 'document-facts'
  | 'import-docs'
  | 'write'
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
  /** Git remotes to clone + index. `kb init` requires at least one. */
  gitTargets?: GitTarget[]
  /**
   * Slug of the repo currently being indexed. Tags every fact written in this run with its
   * originating repo (multi-repo provenance + repo-pool retrieval). Set internally per repo.
   */
  gitRepo?: string
}

/** A git remote to track, with the branch to follow (default `main`). */
export interface GitTarget {
  url: string
  branch: string
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

interface InitCollectionProgress {
  itemsConsidered: number
  itemsCompleted: number
  itemsRemaining: number
  currentItem?: string
}

interface ReadInputsCollectionProgress extends InitCollectionProgress {
  stage: 'source-files' | 'code-files'
}

interface BuildOriginalDocsProgress extends InitCollectionProgress {
  docsBuilt: number
}

interface NormalizeDocsProgress extends InitCollectionProgress {
  docsNormalized: number
}

interface WriteDocsProgress extends InitCollectionProgress {
  docsWritten: number
  currentDocId?: string
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

export interface InitQuestionOptions {
  slashContext?: SlashInputContext
  /** Plain-text inline completions forwarded to TUI autocomplete. */
  suggestions?: string[]
}

export class InitCancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message)
    this.name = 'InitCancelledError'
  }
}

export function isInitCancelledError(error: unknown): error is InitCancelledError {
  return error instanceof InitCancelledError
}

export interface InitQuestionIO {
  write?: (message: string) => void
  askQuestion: (question: string, opts?: InitQuestionOptions) => Promise<string>
  close?: () => Promise<void> | void
}

class InitProgressReporter {
  private completed = 0
  private lastUpdateMs = 0
  private static readonly THROTTLE_MS = 120
  private readonly sink: (line: string) => void
  private readonly ttyMode: boolean

  constructor(
    private total: number,
    private prefix: 'init' | 'scan' = 'init',
    sinkArg?: (line: string) => void
  ) {
    if (sinkArg) {
      this.sink = sinkArg
      this.ttyMode = false
    } else {
      this.sink = line => process.stderr.write(line)
      this.ttyMode = process.stderr.isTTY === true
    }
  }

  start(label: string, detail?: string) {
    this.render(label, detail, false)
  }

  finish(label: string, detail?: string) {
    this.completed += 1
    this.render(label, detail, false)
  }

  update(label: string, detail?: string) {
    if (!this.ttyMode) {
      this.render(label, detail, false)
      return
    }
    const now = Date.now()
    if (now - this.lastUpdateMs < InitProgressReporter.THROTTLE_MS) return
    this.lastUpdateMs = now
    this.render(label, detail, true)
  }

  private render(label: string, detail?: string, inPlace = false) {
    const width = 24
    const filled = Math.round((this.completed / Math.max(this.total, 1)) * width)
    const bar = `${'='.repeat(filled)}${'-'.repeat(Math.max(width - filled, 0))}`
    const suffix = detail ? ` ${detail}` : ''
    const content = `[${this.prefix}] [${bar}] ${this.completed}/${this.total} ${label}${suffix}`
    if (inPlace && this.ttyMode) {
      this.sink(`\r\x1b[K${content}`)
    } else {
      this.sink(`${content}\n`)
    }
  }
}

function clipProgressItem(value: string | undefined, max = 64): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function formatReadInputsProgress(snapshot: ReadInputsCollectionProgress): string {
  const current = clipProgressItem(snapshot.currentItem)
  const label =
    snapshot.stage === 'source-files' ? 'docs' : 'code'
  return `${label} ${snapshot.itemsCompleted} collected${current ? ` | ${current}` : ''}`
}

function formatDocumentFactsProgress(
  snapshot: ScanFactIngestProgress,
  options: { rescan: boolean; unchangedCount: number }
): string {
  const activeFileCount = Math.max(snapshot.filesCompleted, snapshot.filesScanned)
  const counts = options.rescan
    ? `${activeFileCount}/${snapshot.filesConsidered} changed, ${options.unchangedCount} unchanged`
    : `${activeFileCount}/${snapshot.filesConsidered} processed`
  const current = clipProgressItem(snapshot.currentFile)
  return `${counts} | ${snapshot.segmentsUpserted} segments${current ? ` | ${current}` : ''}`
}

function formatImportDocsBuildProgress(
  snapshot: BuildOriginalDocsProgress,
  options: { rescan: boolean; unchangedCount: number }
): string {
  const counts = options.rescan
    ? `${snapshot.docsBuilt}/${snapshot.itemsConsidered} changed, ${options.unchangedCount} unchanged`
    : `${snapshot.docsBuilt}/${snapshot.itemsConsidered} processed`
  const current = clipProgressItem(snapshot.currentItem)
  return `${counts} | building originals${current ? ` | ${current}` : ''}`
}

function formatImportDocsNormalizeProgress(snapshot: NormalizeDocsProgress): string {
  const current = clipProgressItem(snapshot.currentItem)
  return `${snapshot.itemsCompleted}/${snapshot.itemsConsidered} processed | ${snapshot.docsNormalized} normalized${current ? ` | ${current}` : ''}`
}

function formatWriteDocsProgress(
  snapshot: WriteDocsProgress,
  options: { label: string; rescan: boolean; unchangedCount?: number }
): string {
  const counts = options.rescan
    ? `${snapshot.docsWritten}/${snapshot.itemsConsidered} changed, ${options.unchangedCount ?? 0} unchanged`
    : `${snapshot.docsWritten}/${snapshot.itemsConsidered} processed`
  const current = clipProgressItem(snapshot.currentItem ?? snapshot.currentDocId)
  return `${counts} | ${options.label}${current ? ` | ${current}` : ''}`
}

function formatRescanWriteProgress(snapshot: RescanApplyOrchestratorProgress): string {
  const current = clipProgressItem(snapshot.currentItem)
  switch (snapshot.stage) {
    case 'extract-claims':
      return `${snapshot.itemsCompleted}/${snapshot.itemsConsidered} docs processed | ${snapshot.claimsExtracted ?? 0} claims${current ? ` | ${current}` : ''}`
    case 'gather-evidence':
      return `${snapshot.itemsCompleted}/${snapshot.itemsConsidered} claims checked | ${snapshot.evidenceDocsScanned ?? 0} docs scanned${current ? ` | ${current}` : ''}`
    case 'apply-mutations':
      return `${snapshot.itemsCompleted}/${snapshot.itemsConsidered} mutations processed | ${snapshot.appliedMutations ?? 0} applied, ${snapshot.noopMutations ?? 0} noop${current ? ` | ${current}` : ''}`
    case 'preview-diff':
      return `${snapshot.itemsCompleted}/${snapshot.itemsConsidered} preview diffs${current ? ` | ${current}` : ''}`
  }
}

const SOURCE_FILE_CANDIDATES = [
  'README.md',
  'readme.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docs/README.md',
  'docs/overview.md',
  'docs/architecture.md',
]

/** Dirs skipped when collecting markdown sources (keep aligned with tree-sitter skip dirs plus KB/publish paths). */
const MARKDOWN_SOURCE_EXCLUDE_DIRS = new Set([
  // Node.js
  'node_modules',
  '.next',
  '.turbo',
  // Build outputs
  'dist',
  'build',
  'out',
  'target',
  // Caches
  '.cache',
  'coverage',
  '.pytest_cache',
  '.tox',
  // Python
  '__pycache__',
  'venv',
  '.venv',
  // Ruby
  'vendor',
  // IDEs & Editors
  '.git',
  '.idea',
  '.vscode',
  '.DS_Store',
  // Docs/KB
  '.kb',
  '_original_docs',
  '_autogenerated_docs',
  '_data',
  '_graph_pages',
  '_site',
])

const MARKDOWN_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mdx'])

function shouldExcludeMarkdownSourceFile(relativePath: string, content: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase()
  if (
    normalizedPath.includes('/_original_docs/') ||
    normalizedPath.includes('/_autogenerated_docs/')
  ) {
    return true
  }
  if (normalizedPath.endsWith('docs-generate-export.md')) return true
  return content.startsWith('# Dogfood export (docs generate)')
}

export function parseInitCommand(args: string[]): InitOptions {
  const base = readOption(args, '--base') ?? undefined
  const defaultBranch = readOption(args, '--branch') ?? 'main'
  const gitTargets = readAllOptions(args, '--git').map(raw => parseGitTarget(raw, defaultBranch))

  const rawStopAfter = readOption(args, '--stop-after')
  const stopAfter = rawStopAfter
    ? (normalizeStoredCycleId(rawStopAfter) ?? undefined)
    : undefined
  const validCycles: InitCycle[] = [
    'read-inputs',
    'code-index',
    'document-facts',
    'import-docs',
    'write',
  ]
  if (rawStopAfter && (!stopAfter || !validCycles.includes(stopAfter))) {
    throw new Error(`Invalid --stop-after. Use: ${validCycles.join('|')}`)
  }

  return {
    base,
    nonInteractive: readFlag(args, '--non-interactive'),
    rescan: false,
    apply: false,
    detach: readFlag(args, '--detach'),
    resume: readFlag(args, '--resume'),
    stopAfter,
    resumeFrom: readOption(args, '--resume-from'),
    checkpointFile: readOption(args, '--checkpoint-file'),
    gitTargets,
  }
}

/** Parse a `--git` value of the form `url` or `url#branch` into a GitTarget. */
export function parseGitTarget(raw: string, defaultBranch: string): GitTarget {
  const hashIdx = raw.lastIndexOf('#')
  if (hashIdx > 0) {
    return { url: raw.slice(0, hashIdx), branch: raw.slice(hashIdx + 1) || defaultBranch }
  }
  return { url: raw, branch: defaultBranch }
}

export function parseScanCommand(args: string[]): InitOptions {
  return { ...parseInitCommand(args), rescan: true, apply: true }
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

function progressPrefix(options: Pick<InitOptions, 'rescan'>): 'init' | 'scan' {
  return options.rescan ? 'scan' : 'init'
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

  await writeKbFile(cwd, base)
  if (!options.rescan) {
    await writeSessionBase(base)
  }
  const baseDir = await ensureOperationalBaseDir(base, cwd)

  // Resolve where to scan + the repo provenance for facts written this run.
  // - rescan: index `cwd` directly (a clone managed by auto-sync / scan / add-repo), tagged
  //   with the caller-supplied `options.gitRepo`.
  // - fresh init: git is REQUIRED. Clone every target into `repos/<slug>`; index the first
  //   here and the rest via recursive rescan calls below, then reconcile + write meta.
  let scanDir = cwd
  let gitRepoSlug = options.gitRepo
  let primaryRepoMeta: GitRepoMeta | undefined
  let additionalRepos: GitRepoMeta[] = []
  if (!options.rescan) {
    const targets = await resolveGitTargetsForInit(options, questionIO)
    const repoMetas: GitRepoMeta[] = []
    for (const target of targets) {
      const slug = repoSlugFromGitUrl(target.url)
      const dir = repoDirForSlug(slug)
      const repoDir = path.join(baseDir, dir)
      if (!existsSync(repoDir)) {
        await cloneRepo(target.url, repoDir, target.branch)
      }
      await mkdir(repoDir, { recursive: true })
      repoMetas.push({
        gitUrl: target.url,
        gitBranch: target.branch,
        slug,
        dir,
        lastSyncedSha: await getHeadSha(repoDir),
        lastSyncedAt: new Date().toISOString(),
      })
    }
    primaryRepoMeta = repoMetas[0]
    additionalRepos = repoMetas.slice(1)
    scanDir = path.join(baseDir, primaryRepoMeta.dir)
    gitRepoSlug = primaryRepoMeta.slug
  }
  const checkpointFile = await resolveCheckpointPath({ ...options, base }, cwd)
  const resumedCheckpoint = options.rescan ? undefined : await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(6, progressPrefix(options), options.progressSink)
  const rawProvider = options.provider ?? (await resolveProvider())
  const counter =
    rawProvider && options.collector ? new TokenCountingProvider(rawProvider) : undefined
  const provider = counter ?? rawProvider
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
    const interviewRounds: InitInterviewRound[] = []
    let topicCoverage = checkpoint.topicCoverage ?? []

    if (!checkpoint.completedCycles.includes('read-inputs')) {
      progress.start('read-inputs', 'discovering docs…')
      const readResult = await runReadInputsCycle({
        cwd: scanDir,
        baseDir,
        baseName: base,
        rescan: options.rescan === true,
        nonInteractive: options.nonInteractive,
        detach: options.detach,
        questionIO,
        startingRound: 1,
        maxQuestions: 0,
        onProgress: snapshot => {
          progress.update('read-inputs', formatReadInputsProgress(snapshot))
        },
      })
      context = readResult.context
      topicCoverage = readResult.topicCoverage
      await persist({
        context,
        interviewRounds,
        topicCoverage,
        completedCycles: ['read-inputs'],
      })
      progress.finish('read-inputs', `${Object.keys(context.sourceFiles).length} files`)
      if (options.stopAfter === 'read-inputs') throw new InitPausedError('read-inputs')
    } else {
      progress.finish('read-inputs', 'reused from checkpoint')
    }

    if (!context) throw new Error('read-inputs context missing')

    // Ingest cross-repo integration signals (package.json deps, env service refs) so
    // `reconcileCrossRepoEdges` can later bridge this repo to its siblings.
    if (gitRepoSlug) {
      await ingestIntegrationSignals({
        baseDir,
        scanDir,
        gitRepo: gitRepoSlug,
        gitUrl: primaryRepoMeta?.gitUrl,
      })
    }

    const changedSourceFiles = options.rescan
      ? await selectChangedSourceFiles(baseDir, context.sourceFiles)
      : context.sourceFiles
    const totalSourceFileCount = Object.keys(context.sourceFiles).length
    const unchangedSourceFileCount = totalSourceFileCount - Object.keys(changedSourceFiles).length

    if (!checkpoint.completedCycles.includes('code-index')) {
      progress.start('code-index', 'indexing code graph (AST)…')
      try {
        const dbPath = path.join(baseDir, '.kb-index.sqlite')
        const currentAstFiles = await collectAstFileHashes(scanDir)
        const totalAstFileCount = Object.keys(currentAstFiles).length
        const candidateAstFiles = options.rescan
          ? await selectChangedAstFiles(baseDir, currentAstFiles)
          : Object.keys(currentAstFiles)
        const unchangedAstFileCount = totalAstFileCount - candidateAstFiles.length
        if (options.rescan && candidateAstFiles.length === 0) {
          await writeAstFilesManifest(baseDir, currentAstFiles)
        } else {
          let totalFiles = 0
          let totalSymbols = 0
          let totalEdges = 0
          let totalErrors = 0
          let tsStatsSummary: import('../tools/code-graph-indexer').CodeIndexStats | undefined
          let treeStatsSummary: import('../tools/code-graph-indexer').CodeIndexStats | undefined
          const tsCandidateFiles = candidateAstFiles.filter(file => {
            const ext = path.extname(file).toLowerCase()
            return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)
          })
          const totalTsFileCount = Object.keys(currentAstFiles).filter(file => {
            const ext = path.extname(file).toLowerCase()
            return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)
          }).length
          const unchangedTsFileCount = totalTsFileCount - tsCandidateFiles.length

          const tsconfigPath = path.join(scanDir, 'tsconfig.json')
          const treeCandidateFiles = existsSync(tsconfigPath)
            ? candidateAstFiles.filter(file => {
                const ext = path.extname(file).toLowerCase()
                return !['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)
              })
            : candidateAstFiles
          const totalTreeFileCount = totalAstFileCount - totalTsFileCount
          const unchangedTreeFileCount = totalTreeFileCount - treeCandidateFiles.length

          const astFactIndexer = new SqliteKbIndexer({ dbPath })
          astFactIndexer.setActiveGitRepo(gitRepoSlug ?? null)
          try {
            if (existsSync(tsconfigPath) && tsCandidateFiles.length > 0) {
              const indexer = new TsMorphIndexer(dbPath, astFactIndexer)
              const stats = await indexer.indexProject(scanDir, tsconfigPath, {
                candidateFiles: tsCandidateFiles,
                onProgress: s => {
                  progress.update(
                    'code-index',
                    `ts/js ${s.files}/${tsCandidateFiles.length} changed, ${unchangedTsFileCount} unchanged | ${s.symbols} symbols, ${s.edges} edges`
                  )
                },
              })
              indexer.close()
              tsStatsSummary = stats
              totalFiles += stats.files
              totalSymbols += stats.symbols
              totalEdges += stats.edges
              totalErrors += stats.errors
            }

            const treeIndexer = new TreeSitterIndexer(dbPath, astFactIndexer)
            const treeStats = await treeIndexer.indexProject(scanDir, {
              candidateFiles: treeCandidateFiles,
              onProgress: s => {
                progress.update(
                  'code-index',
                  `tree-sitter ${s.files}/${treeCandidateFiles.length} changed, ${unchangedTreeFileCount} unchanged | ${s.symbols} symbols, ${s.edges} edges`
                )
              },
            })
            treeIndexer.close()
            treeStatsSummary = treeStats
            totalFiles += treeStats.files
            totalSymbols += treeStats.symbols
            totalEdges += treeStats.edges
            totalErrors += treeStats.errors

            const allSourceRefs = new Set([
              ...(tsStatsSummary?.sourceRefs ?? []),
              ...treeStats.sourceRefs,
            ])
            tombstoneStaleAstFacts(astFactIndexer, allSourceRefs, gitRepoSlug)
            astFactIndexer.relinkCodeImportEdges()
          } finally {
            astFactIndexer.close()
          }

          await writeAstFilesManifest(baseDir, currentAstFiles)
          const astParts: string[] = []
          if (tsStatsSummary) {
            astParts.push(
              `ts/js ${tsStatsSummary.files} changed, ${unchangedTsFileCount} unchanged`
            )
          }
          if (treeStatsSummary) {
            astParts.push(
              `tree-sitter ${treeStatsSummary.files} changed, ${unchangedTreeFileCount} unchanged`
            )
          }
          progress.update(
            'code-index',
            `${astParts.join(' | ') || `${totalFiles} changed, ${unchangedAstFileCount} unchanged`} | ${totalSymbols} symbols, ${totalEdges} edges${totalErrors > 0 ? `, ${totalErrors} errors` : ''}`
          )
        }


        await persist({ completedCycles: ['code-index'] })
        progress.finish('code-index', 'done')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await persist({ completedCycles: ['code-index'] })
        progress.finish('code-index', `failed (${message.slice(0, 80)})`)
      }
      if (options.stopAfter === 'code-index') throw new InitPausedError('code-index')
    } else {
      progress.finish('code-index', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('document-facts')) {
      const hasAnySourceFiles = Object.keys(context.sourceFiles).length > 0
      if (!hasAnySourceFiles) {
        await persist({
          completedCycles: ['document-facts'],
        })
        progress.finish('document-facts', 'skipped (no markdown documents found)')
      } else {
        progress.start('document-facts', '📄 indexing document sentences into facts…')
        const endScanFacts = makeCycleTimer('document-facts', provider, options.collector, counter)
        if (options.rescan) {
          const manifest = await readSourceFilesManifest(baseDir)
          const purgeIndexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
          try {
            const purged = tombstoneRemovedDocSourceFiles(
              purgeIndexer,
              context.sourceFiles,
              manifest,
              gitRepoSlug
            )
            if (purged > 0) {
              progress.update(
                'document-facts',
                `purged ${purged} segment(s) from deleted source file(s)`
              )
            }
          } finally {
            purgeIndexer.close()
          }
        }
        const ingestStats = await ingestSourceMarkdownFilesAsFacts({
          baseDir,
          files: changedSourceFiles,
          matchAstNodes: true,
          gitRepo: gitRepoSlug,
          onProgress: snapshot => {
            progress.update(
              'document-facts',
              formatDocumentFactsProgress(snapshot, {
                rescan: options.rescan === true,
                unchangedCount: unchangedSourceFileCount,
              })
            )
          },
        })
        endScanFacts()
        await persist({
          completedCycles: ['document-facts'],
        })
        const tombstoneNote =
          ingestStats.segmentsTombstoned > 0
            ? `, ${ingestStats.segmentsTombstoned} stale segment(s) purged`
            : ''
        progress.finish(
          'document-facts',
          options.rescan
            ? `${ingestStats.segmentsUpserted} segments from ${ingestStats.filesScanned} changed, ${unchangedSourceFileCount} unchanged file(s)${tombstoneNote}`
            : `${ingestStats.segmentsUpserted} segments from ${ingestStats.filesScanned} files${tombstoneNote}`
        )
      }
      if (options.stopAfter === 'document-facts') throw new InitPausedError('document-facts')
    } else {
      progress.finish('document-facts', 'reused from checkpoint')
    }

    if (!checkpoint.completedCycles.includes('import-docs')) {
      progress.start('import-docs', 'importing original markdown…')
      const endImport = makeCycleTimer('import-docs', provider, options.collector, counter)
      candidateDocs = normalizeInitDocs(
        buildOriginalDocumentsFromSourceFiles(changedSourceFiles, base, snapshot => {
          progress.update(
            'import-docs',
            formatImportDocsBuildProgress(snapshot, {
              rescan: options.rescan === true,
              unchangedCount: unchangedSourceFileCount,
            })
          )
        }),
        {
          minWords: 0,
          onProgress: snapshot => {
            progress.update('import-docs', formatImportDocsNormalizeProgress(snapshot))
          },
        }
      )
      endImport()
      topicCoverage = assessTopicCoverage(context, candidateDocs, options.nonInteractive)
      const finalCoverageSummary = summariseCoverage(topicCoverage)
      await persist({
        candidateDocs,
        topicCoverage,
        finalCoverageSummary,
        completedCycles: ['import-docs'],
      })
      progress.finish(
        'import-docs',
        options.rescan
          ? `${candidateDocs.length} changed, ${unchangedSourceFileCount} unchanged original doc(s)`
          : `${candidateDocs.length} original doc(s)`
      )
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
            originalWritten = await writeDocs(originals, baseDir, base, snapshot => {
              progress.update(
                'write',
                formatWriteDocsProgress(snapshot, {
                  label: 'writing original docs',
                  rescan: true,
                  unchangedCount: unchangedSourceFileCount,
                })
              )
            })
          }
        }
        const planResult = await runRescanApplyOrchestrator({
          base,
          baseDir,
          cwd: scanDir,
          apply: false,
          sourceFiles: context.sourceFiles,
          candidateDocs,
          onProgress: snapshot => {
            progress.update('write', formatRescanWriteProgress(snapshot))
          },
        })
        let mutationWritten: string[] = []
        const safeguards = planResult.plan.safeguards?.triggered ?? []
        if (safeguards.length > 0) {
          questionIO.write?.(`[kb scan] safeguards triggered: ${safeguards.join(', ')}\n`)
        }
        const applyResult = await runRescanApplyOrchestrator({
          base,
          baseDir,
          cwd: scanDir,
          apply: true,
          sourceFiles: context.sourceFiles,
          candidateDocs,
          onProgress: snapshot => {
            progress.update('write', formatRescanWriteProgress(snapshot))
          },
        })
        mutationWritten = applyResult.writtenDocIds
        if (
          applyResult.plan.apply.appliedMutations > 0 ||
          applyResult.plan.apply.noopMutations > 0
        ) {
          questionIO.write?.(
            `[kb scan] applied ${applyResult.plan.apply.appliedMutations} action(s) (${applyResult.plan.apply.noopMutations} noop).\n`
          )
        }
        writtenDocIds = [...originalWritten, ...mutationWritten]
      } else {
        writtenDocIds = await writeDocs(candidateDocs, baseDir, base, snapshot => {
          progress.update(
            'write',
            formatWriteDocsProgress(snapshot, {
              label: 'writing docs',
              rescan: false,
            })
          )
        })
      }
      const finalCoverageSummary =
        checkpoint.finalCoverageSummary ?? summariseCoverage(topicCoverage)
      await writeSourceFilesManifest(baseDir, buildSourceFileHashes(context.sourceFiles))
      await persist({
        completedCycles: ['write'],
        finalCoverageSummary,
      })
      progress.finish('write', `${writtenDocIds.length} docs written`)
      if (options.stopAfter === 'write') throw new InitPausedError('write')
    } else {
      progress.finish('write', 'reused from checkpoint')
    }

    // Multi-repo init: index the remaining repos into this same base, then bridge them all
    // into one connected graph. (Additional repos reuse the rescan path; they tag their own
    // facts and write no meta — the primary run owns meta.json below.)
    if (!options.rescan && additionalRepos.length > 0) {
      for (const repo of additionalRepos) {
        options.progressSink?.(`[kb init] Indexing additional repo ${repo.slug}…`)
        await runKbInit({
          base,
          cwd: path.join(baseDir, repo.dir),
          rescan: true,
          apply: true,
          nonInteractive: true,
          gitRepo: repo.slug,
          provider: rawProvider,
          collector: options.collector,
          progressSink: options.progressSink,
          questionIO: SILENT_QUESTION_IO,
        })
      }
    }
    if (!options.rescan) {
      const reconcileIndexer = new SqliteKbIndexer({
        dbPath: path.join(baseDir, '.kb-index.sqlite'),
      })
      try {
        const linked = reconcileIndexer.reconcileCrossRepoEdges()
        if (linked > 0) {
          options.progressSink?.(`[kb init] Linked ${linked} cross-repo edge(s).`)
        }
      } finally {
        reconcileIndexer.close()
      }
    }

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
    if (!options.rescan && primaryRepoMeta) {
      await writeBaseMeta(baseDir, { repos: [primaryRepoMeta, ...additionalRepos] })
    }
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
  onProgress?: (snapshot: ReadInputsCollectionProgress) => void
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
        onProgress: options.onProgress,
      })
    : await collectSourceFiles(options.cwd, options.onProgress)
  const context: InitContext = {
    sourceFiles,
    userAnswers: [],
  }

  return {
    context,
    topicCoverage: assessTopicCoverage(context, undefined, true),
  }
}

export async function collectSourceFiles(
  cwd: string,
  onProgress?: (snapshot: ReadInputsCollectionProgress) => void
): Promise<Record<string, string>> {
  const sourceFiles: Record<string, string> = {}
  const seenPaths = new Set<string>()

  const addSourceFile = async (relativePath: string): Promise<boolean> => {
    const normalizedKey = relativePath.replace(/\\/g, '/').toLowerCase()
    if (seenPaths.has(normalizedKey)) return false
    const fullPath = path.join(cwd, relativePath)
    if (!existsSync(fullPath)) return false
    try {
      const content = await readFile(fullPath, 'utf8')
      if (shouldExcludeMarkdownSourceFile(relativePath, content)) return false
      sourceFiles[relativePath.replace(/\\/g, '/')] = content
      seenPaths.add(normalizedKey)
      onProgress?.({
        stage: 'source-files',
        itemsConsidered: Object.keys(sourceFiles).length,
        itemsCompleted: Object.keys(sourceFiles).length,
        itemsRemaining: 0,
        currentItem: relativePath.replace(/\\/g, '/'),
      })
      return true
    } catch {
      return false
    }
  }

  for (const candidate of SOURCE_FILE_CANDIDATES) {
    await addSourceFile(candidate)
  }

  async function walkMarkdownTree(absDir: string): Promise<void> {
    let entries: { name: string; isDir: boolean }[]
    try {
      const raw = await readdir(absDir, { withFileTypes: true })
      entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return
    }

    for (const entry of entries) {
      // Skip all dotfiles/directories
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
  onProgress?: (snapshot: ReadInputsCollectionProgress) => void
}): Promise<Record<string, string>> {
  void options.baseDir
  void options.baseName
  const allSourceFiles = await collectSourceFiles(options.cwd, options.onProgress)
  const n = Object.keys(allSourceFiles).length
  if (n === 0) {
    options.questionIO.write?.(
      '[kb scan] found no markdown sources under the working directory.\n'
    )
  }
  return allSourceFiles
}

function hashFileBuffer(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function collectAstFileHashes(cwd: string): Promise<Record<string, string>> {
  const astFiles: Record<string, string> = {}

  async function walk(absDir: string): Promise<void> {
    let entries: { name: string; isDir: boolean }[]
    try {
      const raw = await readdir(absDir, { withFileTypes: true })
      entries = raw.map(entry => ({ name: entry.name, isDir: entry.isDirectory() }))
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absPath = path.join(absDir, entry.name)
      if (entry.isDir) {
        if (TREE_SITTER_SKIP_DIRS.has(entry.name)) continue
        await walk(absPath)
        continue
      }
      const rel = path.relative(cwd, absPath).replace(/\\/g, '/')
      if (!isTreeSitterIndexablePath(rel)) continue
      try {
        const contents = await readFile(absPath)
        astFiles[rel] = hashFileBuffer(contents)
      } catch {
        // Ignore individual file read failures during collection.
      }
    }
  }

  await walk(cwd)
  return astFiles
}


async function writeDocs(
  docs: CandidateDoc[],
  baseDir: string,
  base: string,
  onProgress?: (snapshot: WriteDocsProgress) => void
): Promise<string[]> {
  const writer = new SqliteDocumentWriter({ baseDir, base })
  const writtenIds: string[] = []
  try {
    for (const [index, doc] of docs.entries()) {
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
      onProgress?.({
        itemsConsidered: docs.length,
        itemsCompleted: index + 1,
        itemsRemaining: Math.max(docs.length - (index + 1), 0),
        currentItem: doc.title,
        currentDocId: result.id,
        docsWritten: writtenIds.length,
      })
    }
  } finally {
    writer.close()
  }

  return writtenIds
}

function createReadlineQuestionIO(): InitQuestionIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    write(message: string) {
      process.stdout.write(message)
    },
    askQuestion(question: string, _opts?: InitQuestionOptions) {
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
    // .kb file in CWD or any ancestor takes priority — no prompt needed
    const kbFileBase = await findKbFile(cwd)
    if (kbFileBase) {
      questionIO.write?.(`[kb scan] Using base from .kb file: ${kbFileBase}\n`)
      return kbFileBase
    }

    if (options.nonInteractive) {
      throw new Error(
        'No .kb file found in this directory. Pass `--base <name>` or cd into a directory with a .kb file.'
      )
    }

    // No .kb file — show a list picker so the user explicitly chooses
    const bases = await listAllBases()
    if (bases.length === 0) {
      throw new Error(
        'No initialized bases found. Run `kb init --base <name>` first.'
      )
    }
    if (bases.length === 1) {
      questionIO.write?.(`[kb scan] Using base: ${bases[0].name}\n`)
      return bases[0].name
    }

    questionIO.write?.('\n[kb scan] Available bases:\n')
    for (const b of bases) {
      const tags = [b.isActive ? 'active' : '', b.isDefault ? 'default' : ''].filter(Boolean)
      const tagStr = tags.length ? `  [${tags.join(', ')}]` : ''
      questionIO.write?.(`  ${b.name}${tagStr}\n`)
    }
    questionIO.write?.('\n')

    const answer = (await questionIO.askQuestion(
      '  > Base name: ',
      { slashContext: 'scan-base-picker', suggestions: bases.map(b => b.name) }
    )).trim()

    if (answer === '/cancel') throw new InitCancelledError()

    const matched = bases.find(b => b.name === answer)
    if (!matched) {
      throw new Error(`Unknown base: "${answer}". Available: ${bases.map(b => b.name).join(', ')}`)
    }
    return matched.name
  }

  const kbFileBase = await findKbFile(cwd)
  const suggestedBase = kbFileBase ?? await resolveSuggestedInitBase(cwd)

  if (options.nonInteractive) {
    throw new Error(CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE)
  }

  questionIO.write?.('\n[kb init] Choose a knowledge base name for this run.\n\n')
  const prompt = suggestedBase
    ? `  > Knowledge base name [${suggestedBase}]\n    `
    : '  > Knowledge base name\n    '
  const answer = (await questionIO.askQuestion(prompt, { slashContext: 'init-free-text' })).trim()
  if (answer === '/cancel') {
    throw new InitCancelledError()
  }
  const resolved = answer || suggestedBase
  if (!resolved) {
    throw new Error(
      'A knowledge base name is required. Use `kb init --base <name>` or enter one when prompted.'
    )
  }
  return resolved
}

/**
 * Resolve the git remotes to index. `kb init` requires at least one — local-directory
 * indexing is no longer supported. CLI `--git` flags win; otherwise prompt interactively
 * (space/comma separated, repeatable until at least one URL is given). Non-interactive with
 * no `--git` is a hard error.
 */
async function resolveGitTargetsForInit(
  options: InitOptions,
  questionIO: InitQuestionIO
): Promise<GitTarget[]> {
  if (options.gitTargets && options.gitTargets.length > 0) return options.gitTargets

  if (options.nonInteractive) {
    throw new Error(
      'kb init requires at least one git remote. Pass `--git <url>` (repeatable; use url#branch for a non-main branch).'
    )
  }

  questionIO.write?.(
    '\n[kb init] Git remote URL(s) to index (space or comma separated; use url#branch for a branch):\n\n'
  )
  for (;;) {
    const answer = (
      await questionIO.askQuestion('  > Git URL(s)\n    ', { slashContext: 'init-free-text' })
    ).trim()
    if (answer === '/cancel') throw new InitCancelledError()
    const targets = answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(raw => parseGitTarget(raw, 'main'))
    if (targets.length > 0) return targets
    questionIO.write?.('  At least one git URL is required.\n')
  }
}

/** A questionIO that never prompts — used for recursive rescans of additional repos. */
const SILENT_QUESTION_IO: InitQuestionIO = {
  write: () => {},
  askQuestion: async () => '',
  close: async () => {},
}

async function resolveSuggestedInitBase(_cwd: string): Promise<string | undefined> {
  const cwdBase = path.basename(_cwd).trim()
  if (cwdBase) return cwdBase
  return 'default'
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
  baseName: string,
  onProgress?: (snapshot: BuildOriginalDocsProgress) => void
): CandidateDoc[] {
  const out: CandidateDoc[] = []
  const paths = Object.keys(sourceFiles).sort()
  for (const [index, relPath] of paths.entries()) {
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
    onProgress?.({
      itemsConsidered: paths.length,
      itemsCompleted: index + 1,
      itemsRemaining: Math.max(paths.length - (index + 1), 0),
      currentItem: posixPath,
      docsBuilt: out.length,
    })
  }
  return out
}

async function selectChangedSourceFiles(
  baseDir: string,
  sourceFiles: Record<string, string>
): Promise<Record<string, string>> {
  const manifest = await readSourceFilesManifest(baseDir)
  const changedPaths = diffChangedSourceFiles(sourceFiles, manifest)
  if (changedPaths === null) return sourceFiles
  const changed: Record<string, string> = {}
  for (const filePath of changedPaths) {
    const content = sourceFiles[filePath]
    if (typeof content === 'string') changed[filePath] = content
  }
  return changed
}

async function selectChangedAstFiles(
  baseDir: string,
  astFiles: Record<string, string>
): Promise<string[]> {
  const manifest = await readAstFilesManifest(baseDir)
  return diffChangedAstFiles(astFiles, manifest) ?? Object.keys(astFiles)
}

function normalizeInitDocs(
  docs: CandidateDoc[],
  options: {
    fallback?: CandidateDoc[]
    preserveMinimumCount?: number
    minWords?: number
    onProgress?: (snapshot: NormalizeDocsProgress) => void
  } = {}
): CandidateDoc[] {
  const normalized: CandidateDoc[] = []
  const seenTitles = new Set<string>()

  for (const [index, raw] of docs.entries()) {
    const cleaned = normalizeInitDoc(raw, options.minWords ?? 0)
    if (cleaned) {
      const title = ensureUniqueTitle(cleaned.title, seenTitles)
      seenTitles.add(title.toLowerCase())
      normalized.push({ ...cleaned, title })
    }
    options.onProgress?.({
      itemsConsidered: docs.length,
      itemsCompleted: index + 1,
      itemsRemaining: Math.max(docs.length - (index + 1), 0),
      currentItem: raw.title,
      docsNormalized: normalized.length,
    })
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
  'code-index',
  'document-facts',
  'import-docs',
  'write',
])

function normalizeStoredCycleId(cycle: string): InitCycle | null {
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
            userAnswers: [],
          }
        : undefined,
      candidateDocs: checkpoint.candidateDocs,
      interviewRounds: [],
      topicCoverage: assessTopicCoverage(
        {
          sourceFiles: checkpoint.context?.sourceFiles ?? {},
          userAnswers: [],
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

/** Collect every `--flag <value>` occurrence (e.g. repeatable `--git`). */
function readAllOptions(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      const value = args[i + 1]
      if (value && !value.startsWith('--')) values.push(value)
    }
  }
  return values
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
