/**
 * kb init / kb scan — knowledge base bootstrap and refresh commands.
 *
 * Step 1 (code-index):       Deterministic AST indexing (tree-sitter WASM grammars for every
 *                             language) → `code_symbols` table (exported symbols + source text).
 * Step 2 (document-index):   Discover markdown sources, index each as a `documents` row linked
 *                             to code symbols via `doc_code_links`, harvest entity ontology,
 *                             import original markdown docs, and write/upsert all documents.
 * Step 3 (create-embeddings): Batch-embed all unembedded documents, code symbols, and facts
 *                             via the configured embedder (e.g. Gemini) with real progress.
 *
 * Reuses progress reporting and checkpoint patterns from the scan/init cycle helpers.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import { deleteRemovedCodeFiles } from '@kb/core/tools/code-fact-writer.js'
import { DOC_TYPES } from '@kb/core/core/doc-taxonomy.js'
import { ingestIntegrationSignals } from '@kb/core/core/integration-ingest.js'
import { runEntityIndexCycle } from '@kb/core/core/entity-index-cycle.js'
import { writePipelineVersion } from '@kb/core/core/pipeline-version.js'
import {
  type ScanDocumentIngestProgress,
  deleteRemovedDocuments,
  indexSourceMarkdownFilesAsDocuments,
} from '@kb/core/core/scan-document-ingest.js'
import type { RunCollector } from '@kb/core/core/telemetry.js'
import { TokenCountingProvider, estimateCost } from '@kb/core/core/telemetry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { WriteDocumentInput } from '@kb/core/tools/document-writer.js'
import {
  type RescanApplyOrchestratorProgress,
  runRescanApplyOrchestrator,
} from '@kb/core/tools/rescan-apply-orchestrator.js'
import { SqliteDocumentWriter } from '@kb/core/tools/sqlite-document-writer.js'
import { requireEmbedderForInit } from '@kb/core/core/embeddings.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import {
  type CodeIndexStats,
  TREE_SITTER_SKIP_DIRS,
  TreeSitterIndexer,
  deleteStaleAstSymbols,
  isTreeSitterIndexablePath,
} from '@kb/core/tools/tree-sitter-indexer.js'
import { scanBaseRepos } from '@kb/core/ops/auto-sync.js'
import { type BaseRepo, discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import {
  repoDirForSlug,
  repoDisplayFromGitUrl,
  repoSlugFromGitUrl,
} from '@kb/core/storage/repo-slug.js'
import {
  DEFAULT_BASE_SLUG,
  ensureOperationalBaseDir,
  getKbHomeDir,
  resolveEffectiveBaseDir,
  writeSessionBase,
} from '@kb/core/storage/base-selection.js'
import { baseNameFromGitUrl, cloneRepo } from '@kb/core/ops/git-sync.js'
import {
  diffChangedAstFiles,
  diffRemovedAstFiles,
  readAstFilesManifest,
  writeAstFilesManifest,
} from '@kb/core/ops/init-ast-files-manifest.js'
import {
  buildSourceFileHashes,
  diffChangedSourceFiles,
  readSourceFilesManifest,
  writeSourceFilesManifest,
} from '@kb/core/ops/init-source-files-manifest.js'
import { assessTopicCoverage, summariseCoverage } from '@kb/core/ops/init-topic-coverage.js'
import { createLLMProviderFromConfig, readKbConfig } from '@kb/core/config/kb-config.js'
import {
  type IgnoreMatcher,
  createIgnoreMatcher,
  readIgnorePatternsFromEnv,
} from '@kb/core/config/kb-ignore.js'

export type InitCycle =
  | 'code-index'
  | 'document-index'
  | 'create-embeddings'
  | 'read-inputs'
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
  progressSink?: (line: string) => void
  collector?: RunCollector
  /** Git remotes to clone + index. `kb init` requires at least one. */
  gitTargets?: GitTarget[]
  /**
   * Slug of the repo currently being indexed. Tags every fact written in this run with its
   * originating repo (multi-repo provenance + repo-pool retrieval). Set internally per repo.
   */
  gitRepo?: string
  /**
   * Gitignore-style patterns for paths to skip while indexing. Supplied internally to
   * recursive per-repo runs; top-level runs fall back to `KB_SERVER_IGNORE`
   * (see `readIgnorePatternsFromEnv`).
   */
  ignorePatterns?: string[]
  /**
   * Treat embedding as mandatory rather than best-effort. When `true`, an embedder failure
   * (rate limit, offline, model unavailable) aborts init instead of silently degrading to the
   * lexical lane. The eval harness sets this: an index without embeddings scores nothing
   * meaningful, so a half-built index must fail loudly rather than be published. Interactive
   * `kb init` leaves this `false` so a missing key never blocks a local index.
   */
  requireEmbeddings?: boolean
  /**
   * Skip the create-embeddings cycle entirely — no embedder is resolved and no vectors are
   * written, even when unembedded rows exist. Marks the cycle complete in the checkpoint like
   * any other finished step, so a later run without this flag re-embeds normally. For a fast
   * reindex where only lexical/AST retrieval is under test (embedding cost/latency not worth
   * paying), not for a published base — a base with no vectors serves the lexical lane only.
   */
  skipEmbeddings?: boolean
}

/** A git remote to track. `branch` is omitted unless the user pins one (inline `#branch` or
 *  `--branch`); when omitted the clone follows the remote's own default branch. */
export interface GitTarget {
  url: string
  branch?: string
}

/** A repo cloned during an init run. Just enough to drive per-repo indexing; nothing is
 *  persisted — the clone on the volume is its own record (see `discoverBaseRepos`). */
interface InitRepoClone {
  gitUrl: string
  slug: string
  dir: string
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

function writeInitNotice(sink: InitOptions['progressSink'], message: string): void {
  const line = `${message}\n`
  if (sink) sink(line)
  else process.stderr.write(line)
}

class InitProgressReporter {
  private completed = 0
  private lastUpdateMs = 0
  private static readonly THROTTLE_MS = 120
  private readonly sink: (line: string) => void
  private readonly ttyMode: boolean
  /** False for injected sinks (tests / callers); true when writing stderr (TTY or Fly logs). */
  private readonly throttleUpdates: boolean
  private repoSlug?: string

  constructor(
    private total = 3,
    private prefix: 'init' | 'scan' = 'init',
    sinkArg?: (line: string) => void
  ) {
    if (sinkArg) {
      this.sink = sinkArg
      this.ttyMode = false
      this.throttleUpdates = false
    } else {
      this.sink = line => process.stderr.write(line)
      this.ttyMode = process.stderr.isTTY === true
      // Throttle TTY redraws and daemon/Fly stderr — otherwise one line per segment
      // floods I/O and starves /healthz during document-facts.
      this.throttleUpdates = true
    }
  }

  setRepo(slug: string | undefined) {
    this.repoSlug = slug
  }

  start(label: string, detail?: string) {
    this.render(label, detail, false, 0)
  }

  finish(label: string, detail?: string) {
    this.completed += 1
    this.render(label, detail, false, 0)
  }

  update(label: string, detail?: string, intraFraction = 0) {
    if (this.throttleUpdates) {
      const now = Date.now()
      if (now - this.lastUpdateMs < InitProgressReporter.THROTTLE_MS) return
      this.lastUpdateMs = now
    }
    this.render(label, detail, this.ttyMode, intraFraction)
  }

  private render(label: string, detail?: string, inPlace = false, intraFraction = 0) {
    const width = 24
    const clampedIntra = Math.min(Math.max(intraFraction, 0), 0.999)
    const progress = Math.min(
      Math.max((this.completed + clampedIntra) / Math.max(this.total, 1), 0),
      1
    )
    const filled = Math.round(progress * width)
    const bar = `${'='.repeat(filled)}${'-'.repeat(Math.max(width - filled, 0))}`
    const suffix = detail ? ` ${detail}` : ''
    const core = `[${bar}] ${this.completed}/${this.total} ${label}${suffix}`
    const content = this.repoSlug
      ? `[${this.prefix}] @ ${this.repoSlug} │ ${core}`
      : `[${this.prefix}] ${core}`
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
  const label = snapshot.stage === 'source-files' ? 'docs' : 'code'
  return `${label} ${snapshot.itemsCompleted} collected${current ? ` | ${current}` : ''}`
}

function formatDocumentIndexProgress(
  snapshot: ScanDocumentIngestProgress,
  options: { rescan: boolean; unchangedCount: number }
): string {
  const activeFileCount = Math.max(snapshot.filesCompleted, snapshot.filesScanned)
  const counts = options.rescan
    ? `${activeFileCount}/${snapshot.filesConsidered} changed, ${options.unchangedCount} unchanged`
    : `${activeFileCount}/${snapshot.filesConsidered} processed`
  const current = clipProgressItem(snapshot.currentFile)
  return `${counts} | ${snapshot.documentsUpserted} documents, ${snapshot.linksWritten} links${current ? ` | ${current}` : ''}`
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
  const defaultBranch = readOption(args, '--branch') ?? undefined
  const gitTargets = readAllOptions(args, '--git').map(raw => parseGitTarget(raw, defaultBranch))

  const rawStopAfter = readOption(args, '--stop-after')
  const stopAfter = rawStopAfter ? (normalizeStoredCycleId(rawStopAfter) ?? undefined) : undefined
  const validCycles: InitCycle[] = [
    'code-index',
    'document-index',
    'create-embeddings',
    'read-inputs',
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
    skipEmbeddings: readFlag(args, '--skip-embed'),
  }
}

/** Parse a `--git` value of the form `url` or `url#branch` into a GitTarget. When no branch is
 *  given (inline or via `defaultBranch`), `branch` is left undefined so the clone follows the
 *  remote's default branch. */
export function parseGitTarget(raw: string, defaultBranch?: string): GitTarget {
  const hashIdx = raw.lastIndexOf('#')
  if (hashIdx > 0) {
    const explicit = raw.slice(hashIdx + 1)
    return { url: raw.slice(0, hashIdx), branch: explicit || defaultBranch }
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
  // Piped/CI/background invocations have no stdin TTY to prompt on; force
  // non-interactive mode so base/git resolution fails fast instead of hanging.
  const options = !process.stdin.isTTY ? { ...inputOptions, nonInteractive: true } : inputOptions
  const cwd = options.cwd ?? process.cwd()

  // Fresh init indexes git clones under ~/.kb — never the caller's working directory.
  // Resolve git remotes before base naming unless we're re-attaching to an existing base.
  let initOptions = options
  if (!options.rescan) {
    const predeclaredBase = options.base?.trim()
    const existingBaseReady =
      predeclaredBase &&
      (await isInitializedGitBase(await ensureOperationalBaseDir(predeclaredBase, cwd)))
    if (!existingBaseReady) {
      const gitTargets = await resolveGitTargetsForInit(options)
      initOptions = { ...options, gitTargets }
    }
  }

  const base = await resolveInitBaseName(initOptions, cwd)

  if (!options.rescan) {
    await writeSessionBase(base)
  }
  const baseDir = await ensureOperationalBaseDir(base, cwd)

  // Idempotent init: when this base already exists (has an index + cloned repos on the
  // volume), a fresh `kb init` would re-index from scratch — undefined territory. Instead
  // swap to the existing base, re-sync its repos, and add any newly-listed `--git` remotes.
  // Recursive per-repo runs (rescan) skip this so they can still re-index in place.
  if (!options.rescan) {
    const existingRepos = await discoverBaseRepos(baseDir)
    const indexExists = existsSync(path.join(baseDir, '.kb-index.sqlite'))
    if (existingRepos.length > 0 && indexExists) {
      return runExistingBaseSwap({ base, baseDir, options, existingRepos })
    }
  }

  // Resolve where to scan + the repo provenance for facts written this run.
  // - rescan: index `cwd` directly (a clone managed by auto-sync / scan / repo add), tagged
  //   with the caller-supplied `options.gitRepo`.
  // - fresh init: git is REQUIRED. Clone every target into `repos/<slug>`; index the first
  //   here and the rest via recursive rescan calls below, then reconcile + write meta.
  let scanDir = cwd
  let gitRepoSlug = options.gitRepo
  // Display-only label ("org/repo", matching GitHub) for the progress line below —
  // never used as the `git_repo` identifier, which stays the filesystem-safe slug.
  let gitRepoDisplay = options.gitRepo
  let primaryRepo: InitRepoClone | undefined
  let additionalRepos: InitRepoClone[] = []
  if (!options.rescan) {
    const targets = initOptions.gitTargets ?? []
    if (targets.length === 0) {
      throw new Error(
        'kb init requires at least one git remote. Pass `--git <url>` (repeatable; use url#branch or --branch to override the remote default).'
      )
    }
    const clones: InitRepoClone[] = []
    for (const target of targets) {
      const slug = repoSlugFromGitUrl(target.url)
      const dir = repoDirForSlug(slug)
      const repoDir = path.join(baseDir, dir)
      if (!existsSync(repoDir)) {
        writeInitNotice(options.progressSink, `[init] cloning ${target.url} → ${repoDir}…`)
        await cloneRepo(target.url, repoDir, target.branch)
        writeInitNotice(options.progressSink, '[init] clone complete.')
      }
      await mkdir(repoDir, { recursive: true })
      clones.push({ gitUrl: target.url, slug, dir })
    }
    primaryRepo = clones[0]
    additionalRepos = clones.slice(1)
    scanDir = path.join(baseDir, primaryRepo.dir)
    gitRepoSlug = primaryRepo.slug
    gitRepoDisplay = repoDisplayFromGitUrl(primaryRepo.gitUrl)
  }

  // Resolve the ignore patterns for this run. Recursive per-repo runs receive them
  // explicitly; everything else reads `KB_SERVER_IGNORE` from the environment.
  const ignorePatterns = options.ignorePatterns ?? readIgnorePatternsFromEnv()
  const ignoreMatcher = createIgnoreMatcher(ignorePatterns)

  const checkpointFile = await resolveCheckpointPath({ ...options, base }, cwd)
  const resumedCheckpoint = options.rescan ? undefined : await readCheckpoint(checkpointFile)

  const progress = new InitProgressReporter(3, progressPrefix(options), options.progressSink)
  if (options.gitRepo ?? gitRepoDisplay) {
    progress.setRepo(options.gitRepo ?? gitRepoDisplay)
  }
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

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1/3: code-index (Deterministic Tree-Sitter AST code indexing)
    // ─────────────────────────────────────────────────────────────────────────
    if (!checkpoint.completedCycles.includes('code-index')) {
      progress.start('code-index', 'indexing code graph (AST)…')
      try {
        const dbPath = path.join(baseDir, '.kb-index.sqlite')
        const currentAstFiles = await collectAstFileHashes(scanDir, ignoreMatcher)
        const totalAstFileCount = Object.keys(currentAstFiles).length
        const candidateAstFiles = options.rescan
          ? await selectChangedAstFiles(baseDir, currentAstFiles, gitRepoSlug)
          : Object.keys(currentAstFiles)
        const unchangedAstFileCount = totalAstFileCount - candidateAstFiles.length
        // Files dropped from this repo since its last manifest must have their facts purged
        // even when no surviving file changed (a pure-deletion rescan), so removals are
        // computed up front and factor into whether the whole cycle can be skipped.
        const removedAstFiles = options.rescan
          ? diffRemovedAstFiles(currentAstFiles, await readAstFilesManifest(baseDir, gitRepoSlug))
          : []
        if (options.rescan && candidateAstFiles.length === 0 && removedAstFiles.length === 0) {
          await writeAstFilesManifest(baseDir, currentAstFiles, gitRepoSlug)
          progress.finish('code-index', `0 changed, ${unchangedAstFileCount} unchanged | 0 symbols`)
        } else {
          // One AST platform for every language: tree-sitter parses a single file at a time
          // (one WASM tree resident at once), so peak memory is bounded by the largest file
          // rather than the whole project graph.
          let treeStatsSummary: CodeIndexStats | undefined

          const symbolIndexer = new SqliteKbIndexer({ dbPath })
          symbolIndexer.setActiveGitRepo(gitRepoSlug ?? null)
          try {
            const treeIndexer = new TreeSitterIndexer(dbPath, symbolIndexer, gitRepoSlug ?? '')
            const treeStats = await treeIndexer.indexProject(scanDir, {
              candidateFiles: candidateAstFiles,
              onProgress: s => {
                const fraction =
                  candidateAstFiles.length > 0 ? s.files / candidateAstFiles.length : 0
                progress.update(
                  'code-index',
                  `${s.files}/${candidateAstFiles.length} changed, ${unchangedAstFileCount} unchanged | ${s.symbols} symbols`,
                  fraction
                )
              },
            })
            treeIndexer.close()
            treeStatsSummary = treeStats

            // Reconcile stale symbols. On a FULL index (fresh init, or a rescan where every
            // file changed) `treeStats.symbolKeys` covers the whole repo, so the blanket
            // reconciliation is safe. On a PARTIAL incremental rescan it only covers the
            // changed files — using it would wrongly purge every unchanged file's symbols —
            // so we instead drop only files that disappeared since the last AST manifest.
            const indexedFullTree = candidateAstFiles.length === totalAstFileCount
            if (indexedFullTree) {
              deleteStaleAstSymbols(symbolIndexer, treeStats.symbolKeys, gitRepoSlug)
            } else {
              deleteRemovedCodeFiles(symbolIndexer, removedAstFiles, gitRepoSlug)
            }
          } finally {
            symbolIndexer.close()
          }

          await writeAstFilesManifest(baseDir, currentAstFiles, gitRepoSlug)
          const s = treeStatsSummary ?? { files: 0, symbols: 0, errors: 0 }
          progress.finish(
            'code-index',
            `${s.files} changed, ${unchangedAstFileCount} unchanged | ${s.symbols} symbols${s.errors > 0 ? `, ${s.errors} errors` : ''}`
          )
        }

        await persist({ completedCycles: ['code-index'] })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await persist({ completedCycles: ['code-index'] })
        progress.finish('code-index', `failed (${message.slice(0, 80)})`)
      }
      if (options.stopAfter === 'code-index') throw new InitPausedError('code-index')
    } else {
      progress.finish('code-index', 'reused from checkpoint')
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2/3: document-index (Discovery, Markdown Ingest, Entity Harvest, Write)
    // ─────────────────────────────────────────────────────────────────────────
    let writtenDocIds: string[] | undefined
    if (!checkpoint.completedCycles.includes('document-index')) {
      progress.start('document-index', 'discovering and indexing documents…')

      // Sub-step: Discover source files (read-inputs)
      if (!context) {
        const readResult = await runReadInputsCycle({
          cwd: scanDir,
          baseDir,
          baseName: base,
          rescan: options.rescan === true,
          nonInteractive: options.nonInteractive,
          detach: options.detach,
          progressSink: options.progressSink,
          ignoreMatcher,
          startingRound: 1,
          maxQuestions: 0,
          onProgress: snapshot => {
            progress.update('document-index', formatReadInputsProgress(snapshot), 0.05)
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
        if (options.stopAfter === 'read-inputs') throw new InitPausedError('read-inputs')
      }

      if (!context) throw new Error('document-index context missing')

      // Ingest cross-repo integration signals (package.json deps, env service refs) so
      // `reconcileCrossRepoEdges` can later bridge this repo to its siblings.
      if (gitRepoSlug) {
        await ingestIntegrationSignals({
          baseDir,
          scanDir,
          gitRepo: gitRepoSlug,
          gitUrl: primaryRepo?.gitUrl,
        })
      }

      const changedSourceFiles = options.rescan
        ? await selectChangedSourceFiles(baseDir, context.sourceFiles, gitRepoSlug)
        : context.sourceFiles
      const totalSourceFileCount = Object.keys(context.sourceFiles).length
      const unchangedSourceFileCount = totalSourceFileCount - Object.keys(changedSourceFiles).length

      const hasAnySourceFiles = totalSourceFileCount > 0
      if (!hasAnySourceFiles) {
        await persist({
          completedCycles: ['document-index', 'import-docs', 'write'],
        })
        progress.finish('document-index', 'skipped (no markdown documents found)')
      } else {
        const endScanDocs = makeCycleTimer('document-index', provider, options.collector, counter)
        let purged = 0
        if (options.rescan) {
          const purgeIndexer = new SqliteKbIndexer({
            dbPath: path.join(baseDir, '.kb-index.sqlite'),
          })
          try {
            purged = deleteRemovedDocuments(purgeIndexer, context.sourceFiles, gitRepoSlug)
            if (purged > 0) {
              progress.update(
                'document-index',
                `purged ${purged} document(s) from deleted source file(s)`,
                0.1
              )
            }
          } finally {
            purgeIndexer.close()
          }
        }

        // Sub-step: Index markdown files as documents linked to AST code symbols
        const ingestStats = await indexSourceMarkdownFilesAsDocuments({
          baseDir,
          files: changedSourceFiles,
          matchAstNodes: true,
          gitRepo: gitRepoSlug,
          onProgress: snapshot => {
            const fileFraction =
              snapshot.filesConsidered > 0 ? snapshot.filesCompleted / snapshot.filesConsidered : 0
            progress.update(
              'document-index',
              formatDocumentIndexProgress(snapshot, {
                rescan: options.rescan === true,
                unchangedCount: unchangedSourceFileCount,
              }),
              0.1 + 0.3 * fileFraction
            )
          },
        })
        endScanDocs()

        // Sub-step: Harvest entity ontology
        progress.update('document-index', 'harvesting entity ontology…', 0.45)
        try {
          const entityStats = await runEntityIndexCycle({
            baseDir,
            scanDir,
            ...(gitRepoSlug ? { gitRepo: gitRepoSlug } : {}),
          })
          const droppedNote =
            entityStats.edgesDropped > 0 ? `, ${entityStats.edgesDropped} edges dropped` : ''
          progress.update(
            'document-index',
            `${entityStats.entitiesUpserted} entities, ${entityStats.edgesWritten} edges, ${entityStats.factsLinked} fact links, ${entityStats.collisions} collisions${droppedNote}`,
            0.6
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          progress.update('document-index', `entities skipped (${message.slice(0, 40)})`, 0.6)
        }

        // Stamp the pipeline version
        try {
          const stampIndexer = new SqliteKbIndexer({
            dbPath: path.join(baseDir, '.kb-index.sqlite'),
          })
          try {
            writePipelineVersion(stampIndexer, gitRepoSlug)
          } finally {
            stampIndexer.close()
          }
        } catch {
          // Best-effort provenance — never fail a scan over the stamp.
        }

        // Sub-step: Import original markdown & evaluate topic coverage
        progress.update('document-index', 'importing original markdown…', 0.65)
        const endImport = makeCycleTimer('import-docs', provider, options.collector, counter)
        candidateDocs = normalizeInitDocs(
          buildOriginalDocumentsFromSourceFiles(changedSourceFiles, base, snapshot => {
            const fraction =
              snapshot.itemsConsidered > 0 ? snapshot.docsBuilt / snapshot.itemsConsidered : 0
            progress.update(
              'document-index',
              formatImportDocsBuildProgress(snapshot, {
                rescan: options.rescan === true,
                unchangedCount: unchangedSourceFileCount,
              }),
              0.65 + 0.15 * fraction
            )
          }),
          {
            minWords: 0,
            onProgress: snapshot => {
              progress.update('document-index', formatImportDocsNormalizeProgress(snapshot), 0.8)
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
        if (options.stopAfter === 'import-docs') throw new InitPausedError('import-docs')

        if (!candidateDocs) throw new Error('document-index candidateDocs missing')

        // Sub-step: Write documents & source files manifest
        progress.update('document-index', 'writing docs…', 0.85)
        if (options.rescan) {
          let originalWritten: string[] = []
          {
            const originals = candidateDocs.filter(doc => doc.isOriginal)
            if (originals.length > 0) {
              originalWritten = await writeDocs(originals, baseDir, base, snapshot => {
                progress.update(
                  'document-index',
                  formatWriteDocsProgress(snapshot, {
                    label: 'writing original docs',
                    rescan: true,
                    unchangedCount: unchangedSourceFileCount,
                  }),
                  0.85
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
              progress.update('document-index', formatRescanWriteProgress(snapshot), 0.9)
            },
          })
          let mutationWritten: string[] = []
          const safeguards = planResult.plan.safeguards?.triggered ?? []
          if (safeguards.length > 0) {
            writeInitNotice(options.progressSink, `[kb scan] safeguards triggered: ${safeguards.join(', ')}`)
          }
          const applyResult = await runRescanApplyOrchestrator({
            base,
            baseDir,
            cwd: scanDir,
            apply: true,
            sourceFiles: context.sourceFiles,
            candidateDocs,
            onProgress: snapshot => {
              progress.update('document-index', formatRescanWriteProgress(snapshot), 0.95)
            },
          })
          mutationWritten = applyResult.writtenDocIds
          if (
            applyResult.plan.apply.appliedMutations > 0 ||
            applyResult.plan.apply.noopMutations > 0
          ) {
            writeInitNotice(
              options.progressSink,
              `[kb scan] applied ${applyResult.plan.apply.appliedMutations} action(s) (${applyResult.plan.apply.noopMutations} noop).`
            )
          }
          writtenDocIds = [...originalWritten, ...mutationWritten]
        } else {
          writtenDocIds = await writeDocs(candidateDocs, baseDir, base, snapshot => {
            progress.update(
              'document-index',
              formatWriteDocsProgress(snapshot, {
                label: 'writing docs',
                rescan: false,
              }),
              0.9
            )
          })
        }

        await writeSourceFilesManifest(
          baseDir,
          buildSourceFileHashes(context.sourceFiles),
          gitRepoSlug
        )
        await persist({
          completedCycles: ['document-index', 'write'],
          finalCoverageSummary,
        })
        const purgeNote = purged > 0 ? `, ${purged} stale document(s) purged` : ''
        const linksNote =
          ingestStats.linksWritten > 0 ? `, ${ingestStats.linksWritten} code link(s)` : ''
        progress.finish(
          'document-index',
          `${writtenDocIds.length} doc(s) written${linksNote}${purgeNote}`
        )
        if (options.stopAfter === 'write') throw new InitPausedError('write')
      }
      if (options.stopAfter === 'document-index') throw new InitPausedError('document-index')
    } else {
      progress.finish('document-index', 'reused from checkpoint')
    }

    // Multi-repo init: index the remaining repos into this same base.
    if (!options.rescan && additionalRepos.length > 0) {
      for (const repo of additionalRepos) {
        await runKbInit({
          base,
          cwd: path.join(baseDir, repo.dir),
          rescan: true,
          apply: true,
          nonInteractive: true,
          gitRepo: repo.slug,
          ignorePatterns,
          provider: rawProvider,
          collector: options.collector,
          progressSink: options.progressSink,
        })
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3/3: create-embeddings (Real neural embeddings with batch progress)
    // ─────────────────────────────────────────────────────────────────────────
    if (!checkpoint.completedCycles.includes('create-embeddings')) {
      if (options.skipEmbeddings) {
        progress.start('create-embeddings', 'skipping (--skip-embed)…')
        progress.finish('create-embeddings', 'skipped (--skip-embed): no vectors written')
        await persist({ completedCycles: ['create-embeddings'] })
        if (options.stopAfter === 'create-embeddings')
          throw new InitPausedError('create-embeddings')
      } else {
        progress.start('create-embeddings', 'resolving embedder…')
        let embedIndexer: SqliteKbIndexer | undefined
        let modelId = ''
        try {
          const embedder = requireEmbedderForInit()
          modelId = embedder.modelId
          embedIndexer = new SqliteKbIndexer({
            dbPath: path.join(baseDir, '.kb-index.sqlite'),
            embedder,
          })
          progress.update('create-embeddings', `embedding with ${embedder.modelId}…`)
          const counts = embedIndexer.countUnembeddedRows(embedder.modelId)
          if (counts.total === 0) {
            progress.finish(
              'create-embeddings',
              `up to date (0 items to embed) with ${embedder.modelId}`
            )
          } else {
            const tableLabels: Record<string, string> = {
              documents: 'docs',
              code_symbols: 'symbols',
              facts: 'facts',
            }
            const res = await embedIndexer.embedAll({
              onProgress: p => {
                const label = tableLabels[p.table] ?? p.table
                const fraction = p.totalItems > 0 ? p.itemsDone / p.totalItems : 0
                if (p.status === 'retry') {
                  const waitSec = Math.round((p.retryWaitMs ?? 0) / 1000)
                  progress.update(
                    'create-embeddings',
                    `${p.itemsDone}/${p.totalItems} (${p.remaining} left) | batch ${p.batchIndex}/${p.totalBatches} retry ${p.retryAttempt}/${p.maxRetries}: ${clipProgressItem(p.retryReason, 40)} (waiting ${waitSec}s)`,
                    fraction
                  )
                } else if (p.status === 'success') {
                  progress.update(
                    'create-embeddings',
                    `${p.itemsDone}/${p.totalItems} (${p.remaining} left) | batch ${p.batchIndex}/${p.totalBatches} done (${p.batchSize} ${label}) with ${p.modelId}`,
                    fraction
                  )
                } else if (p.status === 'start') {
                  progress.update(
                    'create-embeddings',
                    `${p.itemsDone}/${p.totalItems} (${p.remaining} left) | batch ${p.batchIndex}/${p.totalBatches} (${p.batchSize} ${label}) with ${p.modelId}`,
                    fraction
                  )
                }
              },
            })
            progress.finish(
              'create-embeddings',
              `Embedded ${res.documents} doc(s), ${res.symbols} symbol(s), ${res.facts} fact(s) with ${embedder.modelId}.`
            )
          }
          await persist({ completedCycles: ['create-embeddings'] })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (options.requireEmbeddings) {
            throw new Error(
              `kb init embedding failed${modelId ? ` (${modelId})` : ''}: ${message}. Fix the embedder (e.g. GEMINI_API_KEY for KB_EMBEDDER=gemini) and re-run; an index without embeddings is incomplete and cannot be published.`
            )
          }
          progress.finish('create-embeddings', `skipped (${message.slice(0, 80)})`)
          await persist({ completedCycles: ['create-embeddings'] })
        } finally {
          embedIndexer?.close()
        }
        if (options.stopAfter === 'create-embeddings')
          throw new InitPausedError('create-embeddings')
      }
    } else {
      progress.finish('create-embeddings', 'reused from checkpoint')
    }

    writeInitNotice(
      options.progressSink,
      `[${progressPrefix(options)}] Finishing touches: base "${base}" ready.`
    )

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

/**
 * Idempotent `kb init` against an already-initialised base. Instead of re-running the
 * fresh-init pipeline (which would re-index from scratch), this swaps to the existing base,
 * re-syncs the repos already cloned on its volume (pull + re-index any with new commits),
 * and clones + indexes any newly-listed `--git` remotes. Announced through `progressSink`.
 */
async function runExistingBaseSwap(params: {
  base: string
  baseDir: string
  options: InitOptions
  existingRepos: BaseRepo[]
}): Promise<InitResult> {
  const { base, baseDir, options, existingRepos } = params
  const emit = (line: string) => {
    options.progressSink?.(line)
  }

  // Split the requested remotes into "already tracked" (will be re-synced) and "new".
  const trackedSlugs = new Set(existingRepos.map(r => r.slug))
  const seen = new Set<string>()
  const newTargets: GitTarget[] = []
  for (const target of options.gitTargets ?? []) {
    const slug = repoSlugFromGitUrl(target.url)
    if (trackedSlugs.has(slug) || seen.has(slug)) continue
    seen.add(slug)
    newTargets.push(target)
  }

  const addNote = newTargets.length > 0 ? `, adding ${newTargets.length} new repo(s).` : '.'
  emit(
    `[kb init] Base "${base}" already exists — switching to it and re-syncing ${existingRepos.length} tracked repo(s)${addNote}`
  )

  // 1) Re-sync the repos the base already tracks (pull + re-index changed, then reconcile).
  await scanBaseRepos(baseDir, { onProgress: emit })

  // 2) Clone + index any newly-listed remotes into the same base graph. The new clone
  //    becomes part of the on-volume registry, so nothing needs recording afterward.
  if (newTargets.length > 0) {
    const ignorePatterns = options.ignorePatterns ?? readIgnorePatternsFromEnv()
    for (const target of newTargets) {
      const slug = repoSlugFromGitUrl(target.url)
      const dir = repoDirForSlug(slug)
      const repoDir = path.join(baseDir, dir)
      emit(`[kb init] Adding new repo "${repoDisplayFromGitUrl(target.url)}"…`)
      if (!existsSync(repoDir)) {
        await cloneRepo(target.url, repoDir, target.branch)
      }
      await runKbInit({
        base,
        cwd: repoDir,
        rescan: true,
        apply: true,
        nonInteractive: true,
        gitRepo: slug,
        ignorePatterns,
        provider: options.provider,
        collector: options.collector,
        progressSink: options.progressSink,
      })
    }
  }

  emit(`[kb init] Base "${base}" is ready.`)
  return { status: 'accepted', base, completedCycles: [] }
}

async function runReadInputsCycle(options: {
  cwd: string
  baseDir: string
  baseName: string
  rescan: boolean
  nonInteractive: boolean
  detach?: boolean
  progressSink?: InitOptions['progressSink']
  ignoreMatcher?: IgnoreMatcher
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
        progressSink: options.progressSink,
        ignoreMatcher: options.ignoreMatcher,
        onProgress: options.onProgress,
      })
    : await collectSourceFiles(options.cwd, options.onProgress, options.ignoreMatcher)
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
  onProgress?: (snapshot: ReadInputsCollectionProgress) => void,
  ignoreMatcher?: IgnoreMatcher
): Promise<Record<string, string>> {
  const sourceFiles: Record<string, string> = {}
  const seenPaths = new Set<string>()

  const addSourceFile = async (relativePath: string): Promise<boolean> => {
    const normalizedKey = relativePath.replace(/\\/g, '/').toLowerCase()
    if (seenPaths.has(normalizedKey)) return false
    if (ignoreMatcher?.ignores(relativePath.replace(/\\/g, '/'))) return false
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
      const relEntry = path.relative(cwd, absPath).replace(/\\/g, '/')
      if (entry.isDir) {
        if (MARKDOWN_SOURCE_EXCLUDE_DIRS.has(entry.name)) continue
        // Prune ignored subtrees, unless negation rules could re-include something below.
        if (ignoreMatcher && !ignoreMatcher.hasNegation && ignoreMatcher.ignores(relEntry, true)) {
          continue
        }
        await walkMarkdownTree(absPath)
      } else {
        const ext = path.extname(entry.name).toLowerCase()
        if (!MARKDOWN_TEXT_EXTENSIONS.has(ext)) continue
        await addSourceFile(relEntry)
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
  progressSink?: InitOptions['progressSink']
  ignoreMatcher?: IgnoreMatcher
  onProgress?: (snapshot: ReadInputsCollectionProgress) => void
}): Promise<Record<string, string>> {
  void options.baseDir
  void options.baseName
  const allSourceFiles = await collectSourceFiles(
    options.cwd,
    options.onProgress,
    options.ignoreMatcher
  )
  const n = Object.keys(allSourceFiles).length
  if (n === 0) {
    writeInitNotice(options.progressSink, '[kb scan] found no markdown sources under the working directory.')
  }
  return allSourceFiles
}

function hashFileBuffer(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function collectAstFileHashes(
  cwd: string,
  ignoreMatcher?: IgnoreMatcher
): Promise<Record<string, string>> {
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
      const rel = path.relative(cwd, absPath).replace(/\\/g, '/')
      if (entry.isDir) {
        if (TREE_SITTER_SKIP_DIRS.has(entry.name)) continue
        if (ignoreMatcher && !ignoreMatcher.hasNegation && ignoreMatcher.ignores(rel, true)) {
          continue
        }
        await walk(absPath)
        continue
      }
      if (!isTreeSitterIndexablePath(rel)) continue
      if (ignoreMatcher?.ignores(rel)) continue
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
    // Batch every doc write into a single transaction so the store commits once
    // instead of fsync-ing per statement — the dominant cost of this phase.
    await writer.runInTransaction(async () => {
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
    })
  } finally {
    writer.close()
  }

  return writtenIds
}

async function isInitializedGitBase(baseDir: string): Promise<boolean> {
  const repos = await discoverBaseRepos(baseDir)
  return repos.length > 0 && existsSync(path.join(baseDir, '.kb-index.sqlite'))
}

/**
 * Resolve the base name for this run. `kb init`/`kb scan` are server-only (no TTY, no
 * caller supplies interactive input), so there is no prompting — every case either
 * resolves deterministically or throws.
 */
async function resolveInitBaseName(options: InitOptions, cwd: string): Promise<string> {
  if (options.base?.trim()) {
    return options.base.trim()
  }

  if (options.rescan) {
    // Fall back to the selected active base (`kb base use`).
    try {
      const { baseName } = await resolveEffectiveBaseDir(cwd)
      if (baseName?.trim()) {
        writeInitNotice(options.progressSink, `[kb scan] Using base: ${baseName}`)
        return baseName
      }
    } catch {
      // No active base selected — fall through to the error below.
    }
    throw new Error('No base selected. Pass `--base <name>` or set one with `kb base use <name>`.')
  }

  // Fresh init: resolveGitTargetsForInit already guarantees gitTargets is non-empty by
  // the time this runs, so a name is always derivable from the first repo. The
  // DEFAULT_BASE_SLUG fallback is a defensive floor for any future direct caller that
  // skips that guarantee — the same golden default `kb-server init` materializes.
  if (options.gitTargets && options.gitTargets.length > 0) {
    return baseNameFromGitUrl(options.gitTargets[0].url)
  }
  return DEFAULT_BASE_SLUG
}

/**
 * Resolve the git remotes to index. `kb init` requires at least one — local-directory
 * indexing is no longer supported, and (being server-only) there is no interactive
 * fallback: missing `--git` is a hard error.
 */
async function resolveGitTargetsForInit(options: InitOptions): Promise<GitTarget[]> {
  if (options.gitTargets && options.gitTargets.length > 0) return options.gitTargets
  throw new Error(
    'kb init requires at least one git remote. Pass `--git <url>` (repeatable; use url#branch or --branch to override the remote default).'
  )
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
  sourceFiles: Record<string, string>,
  repoSlug?: string
): Promise<Record<string, string>> {
  const manifest = await readSourceFilesManifest(baseDir, repoSlug)
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
  astFiles: Record<string, string>,
  repoSlug?: string
): Promise<string[]> {
  const manifest = await readAstFilesManifest(baseDir, repoSlug)
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
  'code-index',
  'document-index',
  'create-embeddings',
  'read-inputs',
  'import-docs',
  'write',
])

function normalizeStoredCycleId(cycle: string): InitCycle | null {
  if (VALID_V3_CYCLES.has(cycle as InitCycle)) return cycle as InitCycle
  // `document-facts` was the sentence-level ingest replaced by `document-index`. A checkpoint
  // that completed it holds no documents, so it is dropped and the new cycle re-runs.
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
