import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'
import type { LLMProvider, Message } from '../core/types'
import { resolveBaseToDir, resolveEffectiveBaseDir } from './base-selection'

export type PublishPhase = 'package' | 'import' | 'restructure' | 'all'
export type PublishStopPoint = 'package' | 'import' | 'pass1' | 'pass2' | 'pass3' | 'pass4' | 'wiki-write'

export interface PublishOptions {
  base?: string
  provider: 'notion'
  phase: PublishPhase
  apply: boolean
  dryRun: boolean
  archivePath: string
  zipOut?: string
  promptPack: 'notion-v1'
  stagePageId?: string
  checkpointFile?: string
  resumeFrom?: string
  stopAfter?: PublishStopPoint
}

interface KbJsonConfig {
  defaultBase?: string
  sessionBase?: string
  notion?: {
    token?: string
    archivePath?: string
    parentPageId?: string
  }
}

interface PackageResult {
  zipPath: string
  sha256: string
  includedCount: number
  excludedCount: number
  sourceBaseDir: string
  sourceBaseName: string
  manifestPath: string
}

interface NotionImportResult {
  stagePageId: string
  stagePageUrl: string
  rawImportPageId?: string
  rawImportPageUrl?: string
  importedPages: number
  reorganizedPages: number
  timings?: PublishTimings
}

interface RestructureResult extends NotionImportResult {
  checkpoint?: PublishCheckpoint['restructure']
}

interface PublishTimings {
  importMs?: number
  rawImportMs?: number
  restructureMs?: number
  readInputsMs?: number
  pass1Ms?: number
  pass2Ms?: number
  pass3Ms?: number
  pass4Ms?: number
  wikiWriteMs?: number
}

interface PublishCheckpoint {
  version: 1
  updatedAt: string
  baseName: string
  sourceDir: string
  phase: PublishPhase
  artifact?: PackageResult
  notion?: NotionImportResult
  restructure?: {
    pass1?: string
    pass2?: string
    pass3?: string
    pass4?: string
    sections?: Array<{ title: string; markdown: string }>
  }
  completedSteps: PublishStopPoint[]
}

export interface PublishResult {
  status: 'accepted' | 'paused'
  phase: PublishPhase
  apply: boolean
  provider: 'notion'
  artifact?: PackageResult
  notion?: NotionImportResult
  checkpointFile?: string
  resumedFrom?: string
  operatorPrompt?: {
    pack: 'notion-v1'
    targetPage: string
    prompt1: string
    prompt2: string
  }
  warnings?: string[]
}

const DEFAULT_ARCHIVE_PATH = 'Knowledge base/Archive/Zip Imports'
const NOTION_VERSION = '2026-03-11'

class PublishPausedError extends Error {
  constructor(readonly step: PublishStopPoint) {
    super(`Publish paused after ${step}`)
  }
}

class PublishProgressReporter {
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
    process.stderr.write(`[publish] [${bar}] ${this.completed}/${this.total} ${label}${suffix}\n`)
  }
}

export function parsePublishCommand(args: string[]): PublishOptions {
  const provider = readOption(args, '--provider')?.trim().toLowerCase() ?? 'notion'
  if (provider !== 'notion') {
    throw new Error('Only --provider notion is supported in v1')
  }

  const phase = (readOption(args, '--phase')?.trim().toLowerCase() ?? 'all') as PublishPhase
  if (!['package', 'import', 'restructure', 'all'].includes(phase)) {
    throw new Error('Invalid --phase. Use package|import|restructure|all')
  }

  const hasApply = readFlag(args, '--apply')
  const hasDryRun = readFlag(args, '--dry-run')
  if (hasApply && hasDryRun) {
    throw new Error('Use either --apply or --dry-run, not both')
  }

  const apply = hasApply
  const dryRun = hasDryRun || !hasApply

  const promptPack = (readOption(args, '--prompt-pack')?.trim().toLowerCase() ?? 'notion-v1')
  if (promptPack !== 'notion-v1') {
    throw new Error('Only --prompt-pack notion-v1 is supported in v1')
  }

  const stopAfter = readOption(args, '--stop-after')?.trim().toLowerCase() as PublishStopPoint | undefined
  if (stopAfter && !['package', 'import', 'pass1', 'pass2', 'pass3', 'pass4', 'wiki-write'].includes(stopAfter)) {
    throw new Error('Invalid --stop-after. Use package|import|pass1|pass2|pass3|pass4|wiki-write')
  }

  return {
    base: readOption(args, '--base'),
    provider: 'notion',
    phase,
    apply,
    dryRun,
    archivePath: readOption(args, '--archive-path') ?? DEFAULT_ARCHIVE_PATH,
    zipOut: readOption(args, '--zip-out'),
    promptPack: 'notion-v1',
    stagePageId: readOption(args, '--stage-page-id'),
    checkpointFile: readOption(args, '--checkpoint-file'),
    resumeFrom: readOption(args, '--resume-from'),
    stopAfter,
  }
}

export async function runPublishCommand(
  options: PublishOptions,
  cwd: string = process.cwd(),
): Promise<PublishResult> {
  const config = await readKbJsonConfig()
  const baseResolution = await resolvePublishBase(options.base, cwd)
  const checkpointFile = resolveCheckpointFilePath(options, baseResolution.baseName, cwd)
  const resumedCheckpoint = await readPublishCheckpoint(checkpointFile)

  const warnings: string[] = []

  const shouldPackage = options.phase === 'package' || options.phase === 'all' || options.phase === 'import'
  const shouldImport = options.phase === 'import' || options.phase === 'all'
  const shouldRestructure = options.phase === 'restructure' || options.phase === 'all'
  const shouldOutputPrompt = shouldRestructure
  const totalSteps = (shouldPackage ? 1 : 0) + (shouldImport ? 1 : 0) + (shouldRestructure ? 6 : 0)
  const progress = new PublishProgressReporter(totalSteps)

  const token = shouldImport || shouldRestructure ? resolveNotionToken(config) : undefined

  if (options.apply && (shouldImport || shouldRestructure) && !token) {
    throw new Error('Missing Notion token. Set notion.token in ~/.kb/config.json or NOTION_TOKEN/NOTION_API_KEY in env.')
  }

  let checkpoint: PublishCheckpoint = resumedCheckpoint ?? {
    version: 1,
    updatedAt: dayjs().toISOString(),
    baseName: baseResolution.baseName,
    sourceDir: baseResolution.baseDir,
    phase: options.phase,
    completedSteps: [],
  }

  if (resumedCheckpoint) {
    progress.update('resume', `from ${path.basename(checkpointFile)}`)
  }

  let artifact: PackageResult | undefined = checkpoint.artifact
  let notion: NotionImportResult | undefined = checkpoint.notion
  let paused = false

  const persistCheckpoint = async (updates?: Partial<PublishCheckpoint>) => {
    checkpoint = {
      ...checkpoint,
      ...updates,
      updatedAt: dayjs().toISOString(),
      completedSteps: Array.from(new Set([
        ...(checkpoint.completedSteps ?? []),
        ...(updates?.completedSteps ?? []),
      ])),
    }
    await writePublishCheckpoint(checkpointFile, checkpoint)
  }

  try {
    if (shouldPackage) {
      if (artifact) {
        progress.finish('package', 'reused from checkpoint')
      } else {
        progress.start('package', baseResolution.baseName)
        artifact = await buildPublishArtifact({
          baseDir: baseResolution.baseDir,
          baseName: baseResolution.baseName,
          zipOut: options.zipOut,
          dryRun: options.dryRun,
        })
        await persistCheckpoint({
          artifact,
          completedSteps: ['package'],
        })
        progress.finish('package', path.basename(artifact.zipPath))
        if (options.stopAfter === 'package') {
          throw new PublishPausedError('package')
        }
      }
    }

    if (shouldImport) {
      if (!artifact) {
        throw new Error('Packaging artifact missing for import phase.')
      }

      if (checkpoint.completedSteps.includes('import') && notion) {
        progress.finish('import', 'reused from checkpoint')
      } else {
        progress.start('import', 'raw import to Notion')
        const parentPageId = config.notion?.parentPageId

        notion = await importIntoNotion({
          token: token ?? 'dry-run-token',
          archivePath: options.archivePath || config.notion?.archivePath || DEFAULT_ARCHIVE_PATH,
          baseName: baseResolution.baseName,
          artifact,
          sourceDir: baseResolution.baseDir,
          dryRun: options.dryRun,
          parentPageId,
        })
        await persistCheckpoint({
          notion,
          completedSteps: ['import'],
        })
        progress.finish('import', `${notion.importedPages} pages`)
        if (options.stopAfter === 'import') {
          throw new PublishPausedError('import')
        }
      }
    }

    if (shouldRestructure) {
      const targetStagePageId = notion?.stagePageId ?? options.stagePageId

      if (options.apply && !targetStagePageId) {
        throw new Error('Restructure phase requires --stage-page-id when not running import in the same command.')
      }

      const restructureResult = await restructureInNotion({
        token: token ?? 'dry-run-token',
        baseName: baseResolution.baseName,
        sourceDir: baseResolution.baseDir,
        workspaceDir: cwd,
        dryRun: options.dryRun,
        stagePageId: targetStagePageId,
        archivePath: options.archivePath || config.notion?.archivePath || DEFAULT_ARCHIVE_PATH,
        checkpoint: checkpoint.restructure,
        progress,
        stopAfter: options.stopAfter,
        saveCheckpoint: async (restructureCheckpoint, step, partialNotion) => {
          await persistCheckpoint({
            notion: partialNotion ?? notion,
            restructure: restructureCheckpoint,
            completedSteps: [step],
          })
        },
      })

      notion = notion
        ? {
          ...notion,
          reorganizedPages: notion.reorganizedPages + restructureResult.reorganizedPages,
          timings: {
            ...(notion.timings ?? {}),
            ...(restructureResult.timings ?? {}),
          },
        }
        : restructureResult

      await persistCheckpoint({
        notion,
        restructure: restructureResult.checkpoint,
        completedSteps: ['pass1', 'pass2', 'pass3', 'pass4', 'wiki-write'],
      })
    }
  } catch (error) {
    if (error instanceof PublishPausedError) {
      paused = true
      const latestCheckpoint = await readPublishCheckpoint(checkpointFile)
      artifact = latestCheckpoint?.artifact ?? artifact
      notion = latestCheckpoint?.notion ?? notion
      checkpoint = latestCheckpoint ?? checkpoint
      warnings.push(`Publish paused after ${error.step}. Resume with --resume-from ${checkpointFile}`)
    } else {
      throw error
    }
  }

  let operatorPrompt: PublishResult['operatorPrompt']
  if (shouldOutputPrompt) {
    const targetPage = notion?.stagePageUrl
      ?? options.stagePageId
      ?? '(set --stage-page-id or run phase import first)'

    if (!notion && !options.stagePageId) {
      warnings.push('Restructure phase output has no concrete stage page. Run import phase first or pass --stage-page-id.')
    }

    operatorPrompt = {
      pack: 'notion-v1',
      targetPage,
      prompt1: getNotionPromptPack().prompt1,
      prompt2: getNotionPromptPack().prompt2,
    }
  }

  return {
    status: paused ? 'paused' : 'accepted',
    phase: options.phase,
    apply: options.apply,
    provider: options.provider,
    artifact,
    notion,
    checkpointFile,
    resumedFrom: resumedCheckpoint ? checkpointFile : undefined,
    operatorPrompt,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

async function resolvePublishBase(base: string | undefined, cwd: string): Promise<{ baseName: string; baseDir: string }> {
  if (base?.trim()) {
    return {
      baseName: base.trim(),
      baseDir: resolveBaseToDir(base.trim(), cwd),
    }
  }

  const resolved = await resolveEffectiveBaseDir(cwd)
  return {
    baseName: resolved.baseName ?? 'default',
    baseDir: resolved.baseDir,
  }
}

async function readKbJsonConfig(): Promise<KbJsonConfig> {
  const configPath = path.join(os.homedir(), '.kb', 'config.json')
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as KbJsonConfig
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

function resolveNotionToken(config: KbJsonConfig): string | undefined {
  return config.notion?.token?.trim()
    || process.env.NOTION_TOKEN?.trim()
    || process.env.NOTION_API_KEY?.trim()
}

function resolveCheckpointFilePath(
  options: PublishOptions,
  baseName: string,
  cwd: string,
): string {
  const configured = options.resumeFrom || options.checkpointFile
  if (configured) {
    return path.resolve(cwd, configured)
  }

  return path.join(
    cwd,
    '.tmp',
    'notion-publish',
    `${sanitizeFilePart(baseName)}-latest.checkpoint.json`,
  )
}

async function readPublishCheckpoint(filePath: string): Promise<PublishCheckpoint | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as PublishCheckpoint
    if (parsed && parsed.version === 1) {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

async function writePublishCheckpoint(filePath: string, checkpoint: PublishCheckpoint): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

async function buildPublishArtifact(input: {
  baseDir: string
  baseName: string
  zipOut?: string
  dryRun: boolean
}): Promise<PackageResult> {
  const files = await collectMarkdownFiles(input.baseDir)
  const excludedCount = await countExcludedFiles(input.baseDir)

  const timestamp = dayjs().format('YYYY-MM-DD-HHmmss')
  const defaultZipPath = path.join(
    process.cwd(),
    '.tmp',
    'notion-publish',
    `${sanitizeFilePart(input.baseName)}-${timestamp}.zip`,
  )

  const zipPath = input.zipOut ? path.resolve(process.cwd(), input.zipOut) : defaultZipPath
  const manifest = {
    baseName: input.baseName,
    baseDir: input.baseDir,
    createdAt: dayjs().toISOString(),
    includedCount: files.length,
    excludedCount,
    files,
  }

  const manifestPath = `${zipPath}.manifest.json`

  if (!input.dryRun) {
    await mkdir(path.dirname(zipPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const buildDir = await mkdtemp(path.join(path.dirname(zipPath), 'build-'))
    try {
      await copyFilesToBuildDir(input.baseDir, buildDir, files)
      await writeFile(path.join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await runZip(buildDir, zipPath)
    } finally {
      await rm(buildDir, { recursive: true, force: true })
    }
  }

  const sha256 = input.dryRun ? 'dry-run' : await computeSha256(zipPath)

  return {
    zipPath,
    sha256,
    includedCount: files.length,
    excludedCount,
    sourceBaseDir: input.baseDir,
    sourceBaseName: input.baseName,
    manifestPath,
  }
}

async function importIntoNotion(input: {
  token: string
  archivePath: string
  baseName: string
  artifact: PackageResult
  sourceDir: string
  dryRun: boolean
  parentPageId?: string
}): Promise<NotionImportResult> {
  const importStart = performance.now()
  const stagePageTitle = buildStagePageTitle(input.baseName)
  const rawImportTitle = 'Raw Import'

  if (input.dryRun) {
    return {
      stagePageId: 'dry-run-stage-page-id',
      stagePageUrl: `${input.archivePath} / ${stagePageTitle}`,
      rawImportPageId: 'dry-run-raw-import-id',
      rawImportPageUrl: `${input.archivePath} / ${stagePageTitle} / ${rawImportTitle}`,
      importedPages: 0,
      reorganizedPages: 0,
      timings: {
        importMs: 0,
        rawImportMs: 0,
      },
    }
  }

  const useParent = !!(input.parentPageId && input.parentPageId.trim())
  const stagePage = await notionCreatePage({
    token: input.token,
    title: stagePageTitle,
    parentPageId: useParent ? input.parentPageId : undefined,
    asWorkspaceRoot: !useParent,
    markdown: buildStagePageMarkdown(input),
  })

  const rawImportPage = await notionCreatePage({
    token: input.token,
    title: rawImportTitle,
    parentPageId: stagePage.id,
    markdown: [
      '# Raw Import',
      '',
      'This section preserves the imported markdown files as-is for audit and rollback.',
    ].join('\n'),
  })

  const docs = await collectMarkdownFiles(input.sourceDir)
  let importedPages = 0
  const rawImportStart = performance.now()

  for (const relativePath of docs) {
    const absolutePath = path.join(input.sourceDir, relativePath)
    const content = await readFile(absolutePath, 'utf8')
    const title = relativePath.replace(/\.md$/i, '')

    // Use Notion markdown import API
    await notionCreatePage({
      token: input.token,
      parentPageId: rawImportPage.id,
      title,
      markdown: content,
    })
    importedPages += 1
  }

  return {
    stagePageId: stagePage.id,
    stagePageUrl: stagePage.url,
    rawImportPageId: rawImportPage.id,
    rawImportPageUrl: rawImportPage.url,
    importedPages,
    reorganizedPages: 0,
    timings: {
      importMs: Math.round(performance.now() - importStart),
      rawImportMs: Math.round(performance.now() - rawImportStart),
    },
  }
}

async function restructureInNotion(input: {
  token: string
  baseName: string
  sourceDir: string
  workspaceDir: string
  dryRun: boolean
  stagePageId?: string
  archivePath: string
  checkpoint?: PublishCheckpoint['restructure']
  progress: PublishProgressReporter
  stopAfter?: PublishStopPoint
  saveCheckpoint: (
    checkpoint: PublishCheckpoint['restructure'],
    step: PublishStopPoint,
    notion?: NotionImportResult,
  ) => Promise<void>
}): Promise<RestructureResult> {
  const restructureStart = performance.now()
  if (input.dryRun) {
    return {
      stagePageId: input.stagePageId ?? 'dry-run-stage-page-id',
      stagePageUrl: input.stagePageId ?? `${input.archivePath} / ${buildStagePageTitle(input.baseName)}`,
      importedPages: 0,
      reorganizedPages: buildWikiSectionConfigs().length,
      timings: {
        restructureMs: 0,
      },
    }
  }

  if (!input.stagePageId) {
    throw new Error('Restructure phase requires a stage page id.')
  }

  input.progress.start('read-inputs', 'collecting docs + repo context')
  const readInputsStart = performance.now()
  const docs = await readPublishDocuments(input.sourceDir, input.workspaceDir)
  const readInputsMs = Math.round(performance.now() - readInputsStart)
  const provider = tryCreatePublishLlmProvider()
  input.progress.finish('read-inputs', `${docs.length} inputs`)
  const { sections, timings, checkpoint } = provider
    ? await buildWikiSectionsWithIterations(docs, provider, {
      checkpoint: input.checkpoint,
      progress: input.progress,
      stopAfter: input.stopAfter,
      saveCheckpoint: input.saveCheckpoint,
    })
    : {
      sections: buildWikiSectionsDeterministic(docs),
      timings: {} as PublishTimings,
      checkpoint: input.checkpoint,
    }

  input.progress.start('wiki-write', `${sections.length} pages`)
  const wikiWriteStart = performance.now()
  for (const section of sections) {
    await notionCreatePage({
      token: input.token,
      parentPageId: input.stagePageId,
      title: section.title,
      markdown: section.markdown,
    })
  }
  const partialNotion: NotionImportResult = {
    stagePageId: input.stagePageId,
    stagePageUrl: input.stagePageId,
    importedPages: 0,
    reorganizedPages: sections.length,
  }
  await input.saveCheckpoint({
    ...(checkpoint ?? {}),
    sections,
  }, 'wiki-write', partialNotion)
  input.progress.finish('wiki-write', `${sections.length} pages`)
  if (input.stopAfter === 'wiki-write') {
    throw new PublishPausedError('wiki-write')
  }

  return {
    stagePageId: input.stagePageId,
    stagePageUrl: input.stagePageId,
    importedPages: 0,
    reorganizedPages: sections.length,
    checkpoint: {
      ...(checkpoint ?? {}),
      sections,
    },
    timings: {
      ...timings,
      readInputsMs,
      wikiWriteMs: Math.round(performance.now() - wikiWriteStart),
      restructureMs: Math.round(performance.now() - restructureStart),
    },
  }
}

async function notionCreatePage(input: {
  token: string
  parentPageId?: string
  title: string
  asWorkspaceRoot?: boolean
  markdown?: string
}): Promise<{ id: string; url: string }> {
  const parent = input.asWorkspaceRoot
    ? { workspace: true }
    : { page_id: input.parentPageId }

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent,
      properties: {
        title: {
          title: [
            {
              type: 'text',
              text: { content: input.title.slice(0, 200) },
            },
          ],
        },
      },
      ...(input.markdown
        ? {
          markdown: input.markdown,
        }
        : {}),
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 400 && body.includes('public integration')) {
      throw new Error(
        'Notion workspace-root page creation is not supported for internal integrations. Set notion.parentPageId in ~/.kb/config.json and publish under that page.',
      )
    }
    throw new Error(`Notion create page failed (${response.status}): ${body}`)
  }

  const parsed = await response.json() as { id?: string; url?: string }
  if (!parsed.id || !parsed.url) {
    throw new Error('Notion create page response missing id/url')
  }

  return { id: parsed.id, url: parsed.url }
}

interface PublishDocument {
  relativePath: string
  title: string
  promptLabel: string
  summary: string
  headings: string[]
  excerpt: string
  sourceType: 'kb-markdown' | 'repo-markdown' | 'source-code'
}

interface WikiSectionConfig {
  title: string
  description: string
  matcher: (relativePath: string, content: string) => boolean
}

interface SectionOutline {
  title: string
  description: string
  problemFocus?: string
  keyQuestions?: string[]
  keywords?: string[]
}

interface ImplementationDigest {
  summary: string
  headings: string[]
  digest: string
}

function buildWikiSectionConfigs(): WikiSectionConfig[] {
  return [
    {
      title: 'Overview',
      description: 'High-level summary and entry point for the knowledge base.',
      matcher: (relativePath, content) => {
        const normalized = `${relativePath}\n${content}`.toLowerCase()
        return normalized.includes('readme')
          || normalized.includes('overview')
          || normalized.includes('general facts')
          || normalized.includes('_index')
      },
    },
    {
      title: 'Getting Started',
      description: 'Setup, onboarding, CLI usage, and day-one guidance.',
      matcher: (relativePath, content) => {
        const normalized = `${relativePath}\n${content}`.toLowerCase()
        return normalized.includes('getting started')
          || normalized.includes('quick-reference')
          || normalized.includes('cli')
          || normalized.includes('setup')
          || normalized.includes('runbook')
          || normalized.includes('auth')
      },
    },
    {
      title: 'Retrieval & Indexing',
      description: 'Search, retrieval, indexing, storage, and query behavior.',
      matcher: (relativePath, content) => {
        const normalized = `${relativePath}\n${content}`.toLowerCase()
        return normalized.includes('retrieval')
          || normalized.includes('index')
          || normalized.includes('sqlite')
          || normalized.includes('query')
          || normalized.includes('search')
      },
    },
    {
      title: 'Policies & Decisions',
      description: 'Architectural decisions, policies, rules, and implementation constraints.',
      matcher: (relativePath, content) => {
        const normalized = `${relativePath}\n${content}`.toLowerCase()
        return normalized.includes('policy')
          || normalized.includes('decision')
          || normalized.includes('spec')
          || normalized.includes('semantics')
          || normalized.includes('rules')
      },
    },
    {
      title: 'Ticket Timeline',
      description: 'Ticket history, implementation checkpoints, and planning records.',
      matcher: (relativePath) => relativePath.toLowerCase().includes('ticket'),
    },
    {
      title: 'Archive',
      description: 'Everything else that is useful for reference but not primary navigation.',
      matcher: () => true,
    },
  ]
}

async function buildWikiSectionsWithIterations(
  documents: PublishDocument[],
  provider: LLMProvider,
  input: {
    checkpoint?: PublishCheckpoint['restructure']
    progress: PublishProgressReporter
    stopAfter?: PublishStopPoint
    saveCheckpoint: (
      checkpoint: PublishCheckpoint['restructure'],
      step: PublishStopPoint,
    ) => Promise<void>
  },
): Promise<{
  sections: Array<{ title: string; markdown: string }>
  timings: PublishTimings
  checkpoint?: PublishCheckpoint['restructure']
}> {
  const docsOnlySnapshot = buildCorpusSnapshot(
    prioritizeDocuments(
      documents.filter(doc => doc.sourceType !== 'source-code'),
      'docs',
    ),
    { limit: 24, digestLimit: 320 },
  )
  let checkpoint = input.checkpoint ?? {}
  let pass1Ms = 0
  let pass2Ms = 0
  let pass3Ms = 0
  let pass4Ms = 0

  let pass1 = checkpoint.pass1
  if (!pass1) {
    input.progress.start('pass1', 'outline')
    const pass1Start = performance.now()
    pass1 = await callAuthoringModel(provider, [
      userMessage([
        'You are creating a detailed internal wiki for a software project.',
        'Pass 1 of 4: build the initial page outline from the existing project documentation and knowledge-base notes.',
        'Use the current KB notes and README-style docs to understand what the project does, what problem it solves, and what a new engineer needs first.',
        'Ignore implementation notes for this pass.',
        'Write a standalone wiki outline, not a provenance map or document inventory.',
        'Never use raw filenames, note titles, source paths, ticket numbers, or internal "facts" labels as final page titles or headings.',
        'Translate the documentation into human-readable concepts and section titles.',
        'Return JSON only in this shape:',
        '{"projectOverview":"...","problemSolved":"...","sections":[{"title":"...","description":"...","problemFocus":"...","keyQuestions":["..."],"keywords":["..."]}]}',
        '',
        'Current documentation corpus:',
        docsOnlySnapshot,
      ].join('\n')),
    ], {
      maxTokens: 1800,
      temperature: 0.3,
    })
    pass1Ms = Math.round(performance.now() - pass1Start)
    checkpoint = { ...checkpoint, pass1 }
    await input.saveCheckpoint(checkpoint, 'pass1')
    input.progress.finish('pass1', `${pass1Ms}ms`)
    if (input.stopAfter === 'pass1') throw new PublishPausedError('pass1')
  } else {
    input.progress.finish('pass1', 'reused from checkpoint')
  }

  const parsedOutline = parseOutlineJson(pass1)
  const sectionOutlines = finalizeSectionOutlines(parsedOutline?.sections)
  const overviewContext = parsedOutline
    ? `Project overview: ${parsedOutline.projectOverview}\nProblem solved: ${parsedOutline.problemSolved}`
    : 'Project overview and problem framing should be inferred from the project documents.'
  const sectionPackets = buildSectionPackets(documents, sectionOutlines)

  let pass2 = checkpoint.pass2
  if (!pass2) {
    input.progress.start('pass2', 'draft pages')
    const pass2Start = performance.now()
    pass2 = await callAuthoringModel(provider, [
      userMessage([
        'Pass 2 of 4: draft the full wiki as a set of section pages.',
        'Return JSON only in this shape:',
        '{"pages":[{"title":"...","markdown":"..."}]}',
        'Each page should be detailed, readable, and useful to a human engineer.',
        'Start from the documented understanding of the project, then use implementation behavior notes to sharpen accuracy and add missing workflow detail.',
        'Rewrite upward into a high-level product wiki. If something sounds like a note excerpt, document title, or implementation scrap, rewrite it completely.',
        'The first page must be an Overview page that explains what the product is, what problem it solves, and how the rest of the wiki is organized.',
        'Any page about getting started or CLI behavior should cover day-one usage, important commands, and configuration flow, not just precedence rules.',
        'Do not create subsections named after filenames, paths, note ids, ticket labels, or internal "facts" docs.',
        'Never copy imports, type declarations, function signatures, or raw file contents into the final prose.',
        'Use semantic headings like "CLI Command Surface", "Base Selection", or "Publishing Workflow" instead.',
        'You may use tasteful enhanced markdown structures such as callouts, dividers, tables, or toggles when they genuinely improve readability.',
        '',
        overviewContext,
        '',
        'Section packets:',
        sectionPackets,
      ].join('\n')),
    ], {
      maxTokens: 3200,
      temperature: 0.45,
    })
    pass2Ms = Math.round(performance.now() - pass2Start)
    checkpoint = { ...checkpoint, pass2 }
    await input.saveCheckpoint(checkpoint, 'pass2')
    input.progress.finish('pass2', `${pass2Ms}ms`)
    if (input.stopAfter === 'pass2') throw new PublishPausedError('pass2')
  } else {
    input.progress.finish('pass2', 'reused from checkpoint')
  }

  let pass3 = checkpoint.pass3
  if (!pass3) {
    input.progress.start('pass3', 'fill gaps')
    const pass3Start = performance.now()
    pass3 = await callAuthoringModel(provider, [
      userMessage([
        'Pass 3 of 4: review the drafted wiki pages for gaps, factual weak spots, and missing explanation.',
        'Return JSON only in the same shape:',
        '{"pages":[{"title":"...","markdown":"..."}]}',
        'Improve accuracy and completeness.',
        'For each page, ask whether it reads like a high-level product wiki or like a pile of notes. Rewrite toward the wiki.',
        'Use implementation behavior notes to expand concrete CLI usage, workflows, and architecture details when the draft is too surface-level.',
        'Make sure the Overview page clearly explains the product and problem solved, and make sure the Getting Started page explains how to actually use the CLI day to day.',
        'Replace any machine-looking headings with human-friendly conceptual headings.',
        'Do not keep raw note scaffolding such as document counts, "What is here", or "Key topics" headings.',
        '',
        'Current draft set:',
        pass2,
        '',
        'Section packets:',
        sectionPackets,
      ].join('\n')),
    ], {
      maxTokens: 3200,
      temperature: 0.2,
    })
    pass3Ms = Math.round(performance.now() - pass3Start)
    checkpoint = { ...checkpoint, pass3 }
    await input.saveCheckpoint(checkpoint, 'pass3')
    input.progress.finish('pass3', `${pass3Ms}ms`)
    if (input.stopAfter === 'pass3') throw new PublishPausedError('pass3')
  } else {
    input.progress.finish('pass3', 'reused from checkpoint')
  }

  let pass4 = checkpoint.pass4
  if (!pass4) {
    input.progress.start('pass4', 'polish')
    const pass4Start = performance.now()
    pass4 = await callAuthoringModel(provider, [
      userMessage([
        'Pass 4 of 4: polish the wiki pages for readability and presentation.',
        'Return JSON only in the same shape:',
        '{"pages":[{"title":"...","markdown":"..."}]}',
        'Make the writing cohesive, human-readable, and pleasant to scan.',
        'Focus on export readiness: clear flow, strong headings, useful enhanced markdown, and easy scanning.',
        'Remove any lingering low-level implementation phrasing, raw note fragments, document inventories, or repetitive wording.',
        'If any heading still looks like a filename, a path, a ticket label, or a raw note title, rename it to a human-readable concept.',
        '',
        'Draft set to polish:',
        pass3,
      ].join('\n')),
    ], {
      maxTokens: 3200,
      temperature: 0.3,
    })
    pass4Ms = Math.round(performance.now() - pass4Start)
    checkpoint = { ...checkpoint, pass4 }
    await input.saveCheckpoint(checkpoint, 'pass4')
    input.progress.finish('pass4', `${pass4Ms}ms`)
    if (input.stopAfter === 'pass4') throw new PublishPausedError('pass4')
  } else {
    input.progress.finish('pass4', 'reused from checkpoint')
  }

  let parsedPages = parsePagesJson(pass4)
  if ((!parsedPages || parsedPages.length === 0 || pagesNeedRepair(parsedPages)) && provider.name !== 'ollama') {
    const repaired = await callAuthoringModel(provider, [
      userMessage([
        'Repair this wiki draft into strict JSON.',
        'Return JSON only in this exact shape:',
        '{"pages":[{"title":"...","markdown":"..."}]}',
        'Keep the meaning, but rewrite any low-level implementation scraps into normal wiki prose.',
        'Replace any raw filenames, paths, ticket IDs, "facts" labels, note scaffolding, or machine-looking headings with human-readable concepts.',
        'Do not include imports, type declarations, signatures, file contents, or note inventories.',
        'Do not include any prose before or after the JSON.',
        '',
        pass4,
      ].join('\n')),
    ], {
      maxTokens: 3200,
      temperature: 0.1,
    })
    parsedPages = parsePagesJson(repaired)
  }
  if (parsedPages && parsedPages.length > 0) {
    const sections = parsedPages.map(page => ({
      title: page.title,
      markdown: ensureSectionTitle(page.title, page.markdown),
    }))
    return {
      sections,
      timings: { pass1Ms, pass2Ms, pass3Ms, pass4Ms },
      checkpoint: {
        ...checkpoint,
        sections,
      },
    }
  }

  return {
    sections: buildWikiSectionsDeterministic(documents),
    timings: { pass1Ms, pass2Ms, pass3Ms, pass4Ms },
    checkpoint,
  }
}

async function readPublishDocuments(baseDir: string, workspaceDir: string): Promise<PublishDocument[]> {
  const files = await collectMarkdownFiles(baseDir)
  const kbDocs = await Promise.all(files.map(async relativePath => {
    const content = await readFile(path.join(baseDir, relativePath), 'utf8')
    return buildPublishDocument(relativePath, content, 'kb-markdown')
  }))

  const repoContextPaths = [
    'README.md',
    'src/cli/index.ts',
    'src/cli/intent-cli.ts',
    'src/cli/base-selection.ts',
    'src/cli/chat-cli.ts',
    'src/cli/publish-cli.ts',
    'src/tools/kb-tools-registry.ts',
    'src/tools/markdown-document-reader.ts',
    'src/tools/document-writer.ts',
    'src/core/agent-loop.ts',
    'src/core/llm-provider.ts',
  ]

  const repoDocs: PublishDocument[] = []
  for (const relativePath of repoContextPaths) {
    const absolutePath = path.join(workspaceDir, relativePath)
    try {
      const content = await readFile(absolutePath, 'utf8')
      repoDocs.push(buildPublishDocument(
        relativePath,
        content,
        relativePath.endsWith('.md') ? 'repo-markdown' : 'source-code',
      ))
    } catch {
      // Ignore missing optional repo context files.
    }
  }

  return [...kbDocs, ...repoDocs]
}

function buildWikiSectionsDeterministic(documents: PublishDocument[]): Array<{ title: string; markdown: string }> {
  const configs = buildWikiSectionConfigs()
  const used = new Set<string>()

  return configs.map(config => {
    const matchingDocs = documents.filter(doc => {
      if (used.has(doc.relativePath)) return false
      return config.matcher(doc.relativePath, doc.summary)
    })

    if (config.title !== 'Archive') {
      for (const doc of matchingDocs) {
        used.add(doc.relativePath)
      }
    }

    const docsForSection = config.title === 'Archive'
      ? documents.filter(doc => !used.has(doc.relativePath))
      : matchingDocs

    return {
      title: config.title,
      markdown: buildSectionMarkdown(config, docsForSection),
    }
  })
}

function buildPublishDocument(
  relativePath: string,
  content: string,
  sourceType: PublishDocument['sourceType'],
): PublishDocument {
  const title = extractDocumentTitle(relativePath, content)
  const implementationDigest = sourceType === 'source-code'
    ? deriveImplementationDigest(relativePath, content)
    : null
  return {
    relativePath,
    title,
    promptLabel: derivePromptLabel(relativePath, title, content, sourceType),
    summary: implementationDigest?.summary ?? extractDocumentSummary(content),
    headings: implementationDigest?.headings ?? extractDocumentHeadings(content),
    excerpt: implementationDigest?.digest ?? extractMarkdownExcerpt(content),
    sourceType,
  }
}

function buildSectionMarkdown(
  config: Pick<WikiSectionConfig, 'title' | 'description'>,
  documents: PublishDocument[],
): string {
  const lines = [
    `# ${config.title}`,
    '',
    config.description,
    '',
    documents.length > 0
      ? `This page groups the most relevant context for ${config.title.toLowerCase()} and rewrites it into a more readable overview.`
      : 'This page needs a richer rewrite pass because the automatic grouping did not find strong inputs yet.',
  ]

  if (documents.length > 0) {
    lines.push('', '## Main ideas', '')
    for (const document of documents.slice(0, 12)) {
      lines.push(`### ${document.promptLabel}`, '')
      lines.push(document.summary || 'Summary not available from source content.', '')
      if (document.headings.length > 0) {
        lines.push('Helpful angles to cover:', '')
        for (const heading of document.headings.slice(0, 5)) {
          lines.push(`- ${heading}`)
        }
        lines.push('')
      }
    }
  }

  return lines.join('\n').trim()
}

function buildDefaultSectionOutlines(): SectionOutline[] {
  return [
    {
      title: 'Overview',
      description: 'Explain what the project is, what problem it solves, and how the major pieces fit together.',
      problemFocus: 'What is this project and why does it exist?',
      keyQuestions: [
        'What is the product or system?',
        'What problem does it solve?',
        'What are the major moving pieces?',
      ],
      keywords: ['overview', 'readme', 'general', 'architecture'],
    },
    {
      title: 'Getting Started',
      description: 'Explain setup, key commands, workflows, and how to be productive quickly.',
      problemFocus: 'How does a new engineer start using and changing the project successfully?',
      keyQuestions: [
        'How do you run it?',
        'How do you configure it?',
        'What commands matter day to day?',
      ],
      keywords: ['cli', 'setup', 'quick', 'auth', 'runbook'],
    },
    {
      title: 'System Architecture',
      description: 'Explain the important modules, runtime flow, storage model, and extension points.',
      problemFocus: 'How is the system built internally?',
      keyQuestions: [
        'What are the main modules?',
        'How does data move through the system?',
        'What abstractions matter most?',
      ],
      keywords: ['architecture', 'core', 'retrieval', 'index', 'tool'],
    },
    {
      title: 'Retrieval & Data Handling',
      description: 'Explain how documents are stored, updated, indexed, merged, and retrieved across the product.',
      problemFocus: 'How does the system keep knowledge durable and queryable?',
      keyQuestions: [
        'How are documents written and updated over time?',
        'How does retrieval work as the corpus grows?',
        'What indexing or merge behaviors matter most?',
      ],
      keywords: ['retrieval', 'index', 'sqlite', 'document', 'merge', 'search'],
    },
    {
      title: 'Policies & Decisions',
      description: 'Explain the constraints, defaults, and design decisions that shape the codebase.',
      problemFocus: 'What rules and choices govern this project?',
      keyQuestions: [
        'What policies are important?',
        'What decisions affect implementation?',
        'Why were those defaults chosen?',
      ],
      keywords: ['policy', 'decision', 'rules', 'semantics', 'spec'],
    },
    {
      title: 'Project History',
      description: 'Summarize the project evolution and major implementation themes in a readable way.',
      problemFocus: 'How did the project get to its current shape?',
      keyQuestions: [
        'What milestones matter?',
        'What themes show up across implementation work?',
        'What historical context helps a new engineer?',
      ],
      keywords: ['ticket', 'history', 'checkpoint', 'implementation'],
    },
  ]
}

function finalizeSectionOutlines(sections: SectionOutline[] | undefined): SectionOutline[] {
  const defaults = buildDefaultSectionOutlines()
  if (!sections || sections.length === 0) {
    return defaults
  }

  const matchers: Record<string, RegExp> = {
    Overview: /(overview|intro|summary|product|problem)/i,
    'Getting Started': /(getting started|cli|usage|setup|quick|workflow|commands?)/i,
    'System Architecture': /(architecture|codebase|structure|module|component|core)/i,
    'Retrieval & Data Handling': /(retrieval|data|document|merge|index|search|storage)/i,
    'Policies & Decisions': /(policy|policies|decision|best practices|testing|operational|rules)/i,
    'Project History': /(history|evolution|milestone|timeline|checkpoint)/i,
  }

  const used = new Set<number>()
  const merged = defaults.map(defaultOutline => {
    const matcher = matchers[defaultOutline.title]
    const index = sections.findIndex((section, sectionIndex) => {
      if (used.has(sectionIndex)) return false
      const haystack = [
        section.title,
        section.description,
        section.problemFocus,
        ...(section.keyQuestions ?? []),
        ...(section.keywords ?? []),
      ]
        .filter(Boolean)
        .join(' ')
      return matcher.test(haystack)
    })

    if (index === -1) {
      return defaultOutline
    }

    used.add(index)
    const matched = sections[index]
    return {
      title: defaultOutline.title,
      description: matched.description || defaultOutline.description,
      problemFocus: matched.problemFocus || defaultOutline.problemFocus,
      keyQuestions: uniqueStrings([
        ...(defaultOutline.keyQuestions ?? []),
        ...(matched.keyQuestions ?? []),
      ]).slice(0, 6),
      keywords: uniqueStrings([
        ...(defaultOutline.keywords ?? []),
        ...(matched.keywords ?? []),
      ]).slice(0, 10),
    }
  })

  const extras = sections
    .filter((_section, index) => !used.has(index))
    .filter(section => !looksMachineNamed(section.title))
    .slice(0, 2)
    .map(section => ({
      title: section.title.trim(),
      description: section.description.trim(),
      problemFocus: section.problemFocus?.trim(),
      keyQuestions: uniqueStrings(section.keyQuestions ?? []).slice(0, 6),
      keywords: uniqueStrings(section.keywords ?? []).slice(0, 10),
    }))

  return [...merged, ...extras]
}

function derivePromptLabel(
  relativePath: string,
  title: string,
  content: string,
  sourceType: PublishDocument['sourceType'],
): string {
  const normalizedPath = relativePath.toLowerCase()
  const normalizedTitle = title.toLowerCase()
  const normalizedContent = content.toLowerCase()

  const sourceCodeLabels: Record<string, string> = {
    'readme.md': 'Product overview and getting started',
    'src/cli/index.ts': 'CLI entrypoint and command routing',
    'src/cli/intent-cli.ts': 'Intent commands and response formatting',
    'src/cli/base-selection.ts': 'KB base selection and configuration precedence',
    'src/cli/chat-cli.ts': 'Interactive chat workflow',
    'src/cli/publish-cli.ts': 'Notion publishing pipeline',
    'src/tools/kb-tools-registry.ts': 'Tool registry and command surface',
    'src/tools/markdown-document-reader.ts': 'Document retrieval and query behavior',
    'src/tools/document-writer.ts': 'Document mutation operations',
    'src/core/agent-loop.ts': 'Agent execution loop',
    'src/core/llm-provider.ts': 'LLM provider abstraction',
  }

  if (sourceCodeLabels[normalizedPath]) {
    return sourceCodeLabels[normalizedPath]
  }

  if (normalizedPath.includes('ticket') || /^ticket\s+\d+/i.test(title)) {
    if (normalizedContent.includes('merge')) return 'Document operations and merge history'
    if (normalizedContent.includes('checkpoint')) return 'Implementation progress and milestones'
    return 'Project milestones and implementation history'
  }

  if (normalizedTitle.includes('facts')) {
    if (normalizedTitle.includes('cli')) return 'CLI behavior and command facts'
    if (normalizedTitle.includes('readme')) return 'README-derived product and workflow notes'
    if (normalizedTitle.includes('verification')) return 'Verification and persistence notes'
    return 'Reference notes and operational facts'
  }

  if (normalizedTitle.includes('architecture')) return 'System architecture overview'
  if (normalizedTitle.includes('inventory')) return 'Codebase structure overview'
  if (normalizedTitle.includes('session log')) return 'Working session notes'

  if (sourceType === 'source-code') {
    return title
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase())
  }

  return title
}

function deriveImplementationDigest(relativePath: string, content: string): ImplementationDigest {
  const normalizedPath = relativePath.toLowerCase()
  const predefinedDigests: Record<string, ImplementationDigest> = {
    'src/cli/index.ts': {
      summary: 'Defines the top-level CLI surface, routes commands to the right handlers, and keeps the command entrypoint predictable for everyday KB usage.',
      headings: ['Command routing', 'CLI entrypoint', 'Help and invocation flow'],
      digest: 'Use this implementation note to explain how KB presents one command surface while delegating to specialized workflows such as intent commands, chat, and publish.',
    },
    'src/cli/intent-cli.ts': {
      summary: 'Implements the intent-first command experience so users can submit facts, query prior knowledge, validate claims, dispute assumptions, and ask for explanations without dealing with internal tool names.',
      headings: ['Intent commands', 'Response formatting', 'Consumer-facing workflows'],
      digest: 'This area is useful for explaining the day-to-day CLI experience, the intent router, and how KB turns short commands into knowledge operations.',
    },
    'src/cli/base-selection.ts': {
      summary: 'Handles how KB chooses the active knowledge base, including session-level selection, saved defaults, and environment fallback behavior.',
      headings: ['Base selection', 'Configuration precedence', 'Persistent defaults'],
      digest: 'This is the implementation context behind workspace targeting and is useful when explaining how users steer commands toward dogfood, CI, or other namespaces.',
    },
    'src/cli/chat-cli.ts': {
      summary: 'Supports the interactive chat workflow, letting users stay in a conversational loop while still grounding answers in the knowledge base and runtime policies.',
      headings: ['Interactive mode', 'Conversation loop', 'Operator workflow'],
      digest: 'This module helps explain how KB supports exploratory use, not just one-shot commands, while preserving the same retrieval and tool boundaries as the rest of the CLI.',
    },
    'src/cli/publish-cli.ts': {
      summary: 'Coordinates the Notion publication workflow: package current markdown docs, preserve a raw import, generate a cleaner wiki view in multiple passes, and support checkpointed resume behavior.',
      headings: ['Publishing workflow', 'Notion export', 'Checkpoint and resume'],
      digest: 'This is the implementation backdrop for explaining how KB turns an existing knowledge base into a publishable Notion workspace with both audit-friendly raw pages and human-readable wiki pages.',
    },
    'src/tools/kb-tools-registry.ts': {
      summary: 'Defines the tool surface available to the runtime and helps keep consumer-facing workflows aligned with the project’s allowed operations.',
      headings: ['Tool surface', 'Runtime capabilities', 'Consumer-safe operations'],
      digest: 'Use this context when describing which knowledge operations exist and how the runtime decides what capabilities are available during an agent loop.',
    },
    'src/tools/markdown-document-reader.ts': {
      summary: 'Implements document retrieval, including the markdown-first path, optional hybrid search, and the read behavior used by query-oriented commands.',
      headings: ['Document retrieval', 'Hybrid search', 'Query behavior'],
      digest: 'This note is helpful for explaining how KB finds relevant context, how retrieval scales as the corpus grows, and how the system falls back when richer retrieval is unavailable.',
    },
    'src/tools/document-writer.ts': {
      summary: 'Implements document mutation flows such as create, append, update, prune, and merge while keeping persisted markdown and derived indexes in sync.',
      headings: ['Document writes', 'Mutation workflow', 'Index synchronization'],
      digest: 'Use this to explain how durable knowledge gets updated over time and how KB treats persisted markdown as the source of truth while supporting structured edits.',
    },
    'src/core/agent-loop.ts': {
      summary: 'Runs the core execution loop that coordinates model calls, tool use, and iterative progress through a task.',
      headings: ['Agent loop', 'Iteration model', 'Execution orchestration'],
      digest: 'This context helps describe the runtime control flow behind KB’s agent harness and why the system can move through retrieval, tool use, and follow-up steps in sequence.',
    },
    'src/core/llm-provider.ts': {
      summary: 'Provides a shared abstraction over supported language-model providers so the rest of KB can switch providers without rewriting every workflow.',
      headings: ['Provider abstraction', 'Model access', 'Shared runtime interface'],
      digest: 'This area matters when explaining provider flexibility, environment-driven configuration, and the shared contract used by chat, intent commands, and publishing.',
    },
  }

  if (predefinedDigests[normalizedPath]) {
    return predefinedDigests[normalizedPath]
  }

  const headings = extractDocumentHeadings(content).slice(0, 4)
  const readableName = humanizeRelativePath(relativePath)
  const signals = [
    content.includes('query') ? 'query handling' : '',
    content.includes('publish') ? 'publication flow' : '',
    content.includes('chat') ? 'interactive workflows' : '',
    content.includes('provider') ? 'provider integration' : '',
    content.includes('index') ? 'index maintenance' : '',
  ].filter(Boolean)

  return {
    summary: `Captures implementation behavior related to ${readableName} and how it supports the broader KB workflow.`,
    headings: headings.length > 0 ? headings : ['Responsibilities', 'Runtime behavior', 'Operational notes'],
    digest: signals.length > 0
      ? `Use this implementation note to clarify ${signals.join(', ')} in a higher-level wiki explanation.`
      : 'Use this implementation note only to improve accuracy and fill gaps in the wiki, not to preserve low-level phrasing.',
  }
}

function prioritizeDocuments(
  documents: PublishDocument[],
  preference: 'docs' | 'implementation',
): PublishDocument[] {
  const rankBySourceType: Record<'docs' | 'implementation', Record<PublishDocument['sourceType'], number>> = {
    docs: {
      'kb-markdown': 3,
      'repo-markdown': 2,
      'source-code': 1,
    },
    implementation: {
      'source-code': 3,
      'repo-markdown': 2,
      'kb-markdown': 1,
    },
  }

  return [...documents].sort((left, right) => {
    const rankDelta = rankBySourceType[preference][right.sourceType] - rankBySourceType[preference][left.sourceType]
    if (rankDelta !== 0) return rankDelta
    return left.relativePath.localeCompare(right.relativePath)
  })
}

function formatPromptSourceType(sourceType: PublishDocument['sourceType']): string {
  switch (sourceType) {
    case 'kb-markdown':
      return 'current KB note'
    case 'repo-markdown':
      return 'project guide'
    case 'source-code':
      return 'implementation behavior note'
  }
}

function pagesNeedRepair(pages: Array<{ title: string; markdown: string }>): boolean {
  return pagesContainMachineHeadings(pages) || pagesContainLowLevelArtifacts(pages)
}

function pagesContainMachineHeadings(pages: Array<{ title: string; markdown: string }>): boolean {
  return pages.some(page => {
    if (looksMachineNamed(page.title)) return true
    return page.markdown
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^#{1,6}\s+/.test(line))
      .some(line => looksMachineNamed(line.replace(/^#{1,6}\s+/, '')))
  })
}

function looksMachineNamed(value: string): boolean {
  const normalized = value.trim()
  return /(^src\/)|(\.ts$)|(\.md$)|(^ticket\s+\d+)/i.test(normalized)
    || /facts$/i.test(normalized)
    || normalized.includes('/')
}

function pagesContainLowLevelArtifacts(pages: Array<{ title: string; markdown: string }>): boolean {
  return pages.some(page => {
    const body = `${page.title}\n${page.markdown}`
    return looksLikeLowLevelArtifact(body)
  })
}

function looksLikeLowLevelArtifact(value: string): boolean {
  return /^\s*import\s+.+from\s+['"`].+['"`]/m.test(value)
    || /\bnode:[a-z]/i.test(value)
    || /\bToolExecutor\b|\bLLMProvider\b|\bRequestInit\b/.test(value)
    || /^##\s+What is here$/im.test(value)
    || /^##\s+Key topics$/im.test(value)
    || /\bsource documents?\b/i.test(value)
}

function buildCorpusSnapshot(
  documents: PublishDocument[],
  options: { limit?: number; digestLimit?: number } = {},
): string {
  const limit = options.limit ?? 20
  const digestLimit = options.digestLimit ?? 360

  return documents.slice(0, limit).map(doc => [
    `Concept: ${doc.promptLabel}`,
    `Context role: ${formatPromptSourceType(doc.sourceType)}`,
    `Narrative summary: ${doc.summary || 'No summary available.'}`,
    doc.headings.length > 0 ? `Headings: ${doc.headings.slice(0, 6).join(' | ')}` : 'Headings: none',
    `Useful detail: ${(doc.excerpt || 'No digest available.').slice(0, digestLimit)}`,
    '',
  ].join('\n')).join('\n')
}

function buildSectionCorpus(
  documents: PublishDocument[],
  options: { limit?: number; digestLimit?: number } = {},
): string {
  const limit = options.limit ?? 6
  const digestLimit = options.digestLimit ?? 700

  return documents.slice(0, limit).map(doc => [
    `Concept: ${doc.promptLabel}`,
    `Context role: ${formatPromptSourceType(doc.sourceType)}`,
    `Narrative summary: ${doc.summary || 'No summary available.'}`,
    doc.headings.length > 0 ? `Headings: ${doc.headings.slice(0, 8).join(' | ')}` : 'Headings: none',
    `Useful detail: ${(doc.excerpt || 'No digest available.').slice(0, digestLimit)}`,
    '',
  ].join('\n')).join('\n')
}

function buildSectionPackets(
  documents: PublishDocument[],
  outlines: SectionOutline[],
): string {
  return outlines.map(outline => {
    const projectNotes = selectDocumentsForOutline(
      documents.filter(doc => doc.sourceType !== 'source-code'),
      outline,
      { preference: 'docs', limit: 6 },
    )
    const implementationNotes = selectDocumentsForOutline(
      documents.filter(doc => doc.sourceType === 'source-code'),
      outline,
      { preference: 'implementation', limit: 4 },
    )

    return [
      `Section: ${outline.title}`,
      `Description: ${outline.description}`,
      `Problem focus: ${outline.problemFocus ?? 'Explain the relevant problem clearly.'}`,
      `Questions: ${(outline.keyQuestions ?? []).join(' | ') || 'What is this? Why does it exist? How does it work?'}`,
      'Writing rules:',
      '- Start from the current project notes and existing documentation.',
      '- Use implementation behavior notes only to improve accuracy and fill gaps.',
      '- Rewrite upward into a high-level human explanation, not a pile of note excerpts.',
      '- Do not use raw filenames, paths, doc IDs, "facts" titles, or ticket numbers as final headings or subsections.',
      '- Do not quote code, imports, type declarations, or file contents directly in the final wiki writing.',
      '',
      'Current project notes:',
      buildSectionCorpus(projectNotes, { limit: 6, digestLimit: 650 }),
      implementationNotes.length > 0
        ? [
          '',
          'Implementation behavior notes:',
          buildSectionCorpus(implementationNotes, { limit: 4, digestLimit: 420 }),
        ].join('\n')
        : '',
      '',
    ].join('\n')
  }).join('\n')
}

function selectDocumentsForOutline(
  documents: PublishDocument[],
  outline: SectionOutline,
  options: { preference?: 'docs' | 'implementation'; limit?: number } = {},
): PublishDocument[] {
  const keywords = (outline.keywords ?? []).map(keyword => keyword.toLowerCase())
  const scored = documents.map(doc => {
    const haystack = `${doc.title}\n${doc.relativePath}\n${doc.summary}\n${doc.headings.join('\n')}`.toLowerCase()
    let score = 0
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) score += 3
    }
    if (haystack.includes(outline.title.toLowerCase())) score += 4
    return { doc, score }
  })

  const matches = scored
    .filter(item => item.score > 0)
    .sort((a, b) => {
      const scoreDelta = b.score - a.score
      if (scoreDelta !== 0) return scoreDelta
      return prioritizeDocuments([a.doc, b.doc], options.preference ?? 'docs')[0] === a.doc ? -1 : 1
    })
    .map(item => item.doc)

  const limit = options.limit ?? 8
  return matches.length > 0
    ? matches.slice(0, limit)
    : prioritizeDocuments(documents, options.preference ?? 'docs').slice(0, limit)
}

async function callAuthoringModel(
  provider: LLMProvider,
  messages: Message[],
  options: { maxTokens: number; temperature: number },
): Promise<string> {
  const response = await provider.call({
    messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  })

  const text = response.text.trim()
  if (!text) {
    throw new Error(`Publish authoring model returned empty text from provider ${provider.name}.`)
  }
  return text
}

function parseOutlineJson(text: string): { projectOverview: string; problemSolved: string; sections: SectionOutline[] } | null {
  const jsonCandidate = extractJsonObject(text)
  if (!jsonCandidate) return null

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      projectOverview?: string
      problemSolved?: string
      sections?: Array<{
        title?: string
        description?: string
        problemFocus?: string
        keyQuestions?: string[]
        keywords?: string[]
      }>
    }

    if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      return null
    }

    const sections = parsed.sections
      .filter(section => section.title && section.description)
      .map(section => ({
        title: section.title!.trim(),
        description: section.description!.trim(),
        problemFocus: section.problemFocus?.trim(),
        keyQuestions: Array.isArray(section.keyQuestions) ? section.keyQuestions.map(q => q.trim()) : [],
        keywords: Array.isArray(section.keywords) ? section.keywords.map(k => k.trim()) : [],
      }))

    if (sections.length === 0) return null

    return {
      projectOverview: parsed.projectOverview ?? '',
      problemSolved: parsed.problemSolved ?? '',
      sections,
    }
  } catch {
    return null
  }
}

function parsePagesJson(text: string): Array<{ title: string; markdown: string }> | null {
  const jsonCandidate = extractJsonObject(text)
  if (!jsonCandidate) return null

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      pages?: Array<{ title?: string; markdown?: string }>
    }

    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      return null
    }

    const pages = parsed.pages
      .filter(page => page.title && page.markdown)
      .map(page => ({
        title: page.title!.trim(),
        markdown: page.markdown!.trim(),
      }))

    return pages.length > 0 ? pages : null
  } catch {
    return null
  }
}

function extractJsonObject(text: string): string | null {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }
  return text.slice(firstBrace, lastBrace + 1)
}

function ensureSectionTitle(title: string, markdown: string): string {
  const trimmed = markdown.trim()
  if (trimmed.startsWith('# ')) {
    return trimmed
  }
  return `# ${title}\n\n${trimmed}`
}

function userMessage(content: string): Message {
  return {
    role: 'user',
    content,
    metadata: { timestamp: dayjs().valueOf() },
  }
}

function extractDocumentTitle(relativePath: string, content: string): string {
  const heading = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('# '))

  return heading?.replace(/^#\s+/, '').trim()
    || relativePath.replace(/\.md$/i, '')
}

function extractDocumentSummary(content: string): string {
  const lines = content
    .split('\n')
    .map(line => normalizeNarrativeLine(line.trim()))
    .filter(line => line.length > 0)
    .filter(line => !line.startsWith('#'))
    .filter(line => !line.startsWith('Created:'))
    .filter(line => !line.startsWith('Type:'))
    .filter(line => !line.startsWith('Tags:'))
    .filter(line => !line.startsWith('|'))

  return lines.slice(0, 3).join(' ').slice(0, 420)
}

function extractMarkdownExcerpt(content: string): string {
  const lines = content
    .split('\n')
    .map(line => normalizeNarrativeLine(line.trim()))
    .filter(line => line.length > 0)
    .filter(line => !line.startsWith('Created:'))
    .filter(line => !line.startsWith('Type:'))
    .filter(line => !line.startsWith('Tags:'))
    .filter(line => !line.startsWith('|'))

  return lines.join('\n').slice(0, 1400)
}

function extractDocumentHeadings(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^##+\s+/.test(line))
    .map(line => line.replace(/^##+\s+/, ''))
}

function normalizeNarrativeLine(line: string): string {
  return line
    .replace(/\s*\(source:[^)]+\)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function humanizeRelativePath(relativePath: string): string {
  const baseName = path.basename(relativePath).replace(/\.[a-z0-9]+$/i, '')
  return baseName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

function buildStagePageTitle(baseName: string): string {
  return `${baseName} Publish ${dayjs().format('YYYY-MM-DD HH:mm')}`
}

function buildStagePageMarkdown(input: {
  archivePath: string
  baseName: string
  artifact: PackageResult
}): string {
  return [
    '# Publish Run',
    '',
    `Archive target: ${input.archivePath}`,
    '',
    `Base: ${input.baseName}`,
    `Included markdown files: ${input.artifact.includedCount}`,
    `Excluded files: ${input.artifact.excludedCount}`,
    `ZIP SHA-256: ${input.artifact.sha256}`,
    '',
    'This stage page contains two outputs:',
    '- Raw Import: markdown files imported as-is.',
    '- Reorganized Wiki: generated navigation-oriented summary pages.',
  ].join('\n')
}

function getNotionPromptPack(): { prompt1: string; prompt2: string } {
  return {
    prompt1: [
      'You are writing a polished, detailed internal wiki for this software project.',
      '',
      'Critical instructions:',
      '1) Start with what the project does and what problem it solves.',
      '2) Organize by human understanding, not by source filenames.',
      '3) Explain systems, workflows, and design choices in readable prose.',
      '4) The wiki should stand on its own without provenance sections or document inventories.',
      '5) Preserve factual accuracy while rewriting for clarity.',
      '6) Produce clear top-level sections such as Overview, Getting Started, Architecture, Policies & Decisions, and Project History.',
      '7) Keep a "Raw Import" sub-page untouched for audit and reference.',
    ].join('\n'),
    prompt2: [
      'Perform a final quality pass on the wiki pages.',
      '',
      'Goals:',
      '- Improve readability and flow for a new engineer with no prior context.',
      '- Remove repetition and awkward phrasing.',
      '- Make the pages feel like a cohesive internal wiki, not generated notes.',
      '- Keep technical precision; do not invent behavior.',
      '- Remove leftover note fragments, document inventories, and low-level implementation scraps.',
    ].join('\n'),
  }
}

function resolvePublishProviderFromEnv():
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | undefined {
  const raw = (process.env.LLM_PROVIDER || '').trim().toLowerCase()

  if (raw === 'openapi') return 'openai'
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini' || raw === 'ollama') {
    return raw
  }
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  return undefined
}

function tryCreatePublishLlmProvider(): LLMProvider | undefined {
  try {
    const provider = resolvePublishProviderFromEnv()
    if (!provider) return undefined
    switch (provider) {
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY
          ? createProvider({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY })
          : undefined
      case 'openai':
        return process.env.OPENAI_API_KEY
          ? createProvider({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY })
          : undefined
      case 'gemini':
        return process.env.GEMINI_API_KEY
          ? createProvider({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY })
          : undefined
      case 'ollama':
      default:
        return createProvider({
          provider: 'ollama',
          endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
        })
    }
  } catch {
    return undefined
  }
}

async function collectMarkdownFiles(baseDir: string): Promise<string[]> {
  const entries = await listFilesRecursive(baseDir)
  return entries
    .filter(filePath => filePath.toLowerCase().endsWith('.md'))
    .filter(filePath => !path.basename(filePath).startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
}

async function countExcludedFiles(baseDir: string): Promise<number> {
  const entries = await listFilesRecursive(baseDir)
  return entries.filter(filePath => {
    const name = path.basename(filePath)
    return name === '.kb-index.sqlite' || !filePath.toLowerCase().endsWith('.md')
  }).length
}

async function listFilesRecursive(baseDir: string): Promise<string[]> {
  const out: string[] = []

  async function walk(currentRelative: string): Promise<void> {
    const currentAbsolute = path.join(baseDir, currentRelative)
    const entries = await readdir(currentAbsolute, { withFileTypes: true })
    for (const entry of entries) {
      const relative = currentRelative ? path.join(currentRelative, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(relative)
        continue
      }
      if (!entry.isFile()) continue
      out.push(relative)
    }
  }

  await walk('')
  return out
}

async function copyFilesToBuildDir(baseDir: string, buildDir: string, files: string[]): Promise<void> {
  for (const relativePath of files) {
    const source = path.join(baseDir, relativePath)
    const destination = path.join(buildDir, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}

async function runZip(sourceDir: string, zipPath: string): Promise<void> {
  await mkdir(path.dirname(zipPath), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const child = spawn('zip', ['-q', '-r', zipPath, '.'], {
      cwd: sourceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`zip command failed with code ${code}: ${stderr}`))
    })
  })
}

async function computeSha256(filePath: string): Promise<string> {
  const crypto = await import('node:crypto')
  const content = await readFile(filePath)
  const hash = crypto.createHash('sha256')
  hash.update(content)
  return hash.digest('hex')
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

function readOption(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${key} requires a value`)
  }
  return value
}

function readFlag(args: string[], key: string): boolean {
  return args.includes(key)
}
