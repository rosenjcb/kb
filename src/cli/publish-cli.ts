async function notionAppendChildren(input: {
  token: string
  blockId: string
  children: Array<Record<string, unknown>>
}): Promise<void> {
  const response = await fetch(`https://api.notion.com/v1/blocks/${input.blockId}/children`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children: input.children }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Notion append children failed (${response.status}): ${body}`)
  }
}
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import dayjs from 'dayjs'
import { resolveBaseToDir, resolveEffectiveBaseDir } from './base-selection'

export type PublishPhase = 'package' | 'import' | 'restructure' | 'all'

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
  importedPages: number
}

export interface PublishResult {
  status: 'accepted'
  phase: PublishPhase
  apply: boolean
  provider: 'notion'
  artifact?: PackageResult
  notion?: NotionImportResult
  operatorPrompt?: {
    pack: 'notion-v1'
    targetPage: string
    prompt1: string
    prompt2: string
  }
  warnings?: string[]
}

const DEFAULT_ARCHIVE_PATH = 'Knowledge base/Archive/Zip Imports'
const NOTION_VERSION = '2022-06-28'

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
  }
}

export async function runPublishCommand(
  options: PublishOptions,
  cwd: string = process.cwd(),
): Promise<PublishResult> {
  const config = await readKbJsonConfig()
  const baseResolution = await resolvePublishBase(options.base, cwd)

  const warnings: string[] = []

  let artifact: PackageResult | undefined
  let notion: NotionImportResult | undefined

  const shouldPackage = options.phase === 'package' || options.phase === 'all' || options.phase === 'import'
  const shouldImport = options.phase === 'import' || options.phase === 'all'
  const shouldOutputPrompt = options.phase === 'restructure' || options.phase === 'all'

  if (shouldPackage) {
    artifact = await buildPublishArtifact({
      baseDir: baseResolution.baseDir,
      baseName: baseResolution.baseName,
      zipOut: options.zipOut,
      dryRun: options.dryRun,
    })
  }

  if (shouldImport) {
    const token = resolveNotionToken(config)

    if (options.apply) {
      if (!token) {
        throw new Error('Missing Notion token. Set notion.token in ~/.kb/config.json or NOTION_TOKEN/NOTION_API_KEY in env.')
      }
    }

    if (!artifact) {
      throw new Error('Packaging artifact missing for import phase.')
    }

    // Use parentPageId from config if not provided in options
    const parentPageId = options.stagePageId || config.notion?.parentPageId

    notion = await importIntoNotion({
      token: token ?? 'dry-run-token',
      archivePath: options.archivePath || config.notion?.archivePath || DEFAULT_ARCHIVE_PATH,
      baseName: baseResolution.baseName,
      artifact,
      sourceDir: baseResolution.baseDir,
      dryRun: options.dryRun,
      parentPageId,
    })
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
    status: 'accepted',
    phase: options.phase,
    apply: options.apply,
    provider: options.provider,
    artifact,
    notion,
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
  const pageTitle = 'Raw Import'

  if (input.dryRun) {
    return {
      stagePageId: 'dry-run-raw-import-id',
      stagePageUrl: `${input.archivePath} / ${pageTitle}`,
      importedPages: 0,
    }
  }

  const useParent = !!(input.parentPageId && input.parentPageId.trim())
  const rawImportPage = await notionCreatePage({
    token: input.token,
    title: pageTitle,
    parentPageId: useParent ? input.parentPageId : undefined,
    asWorkspaceRoot: !useParent,
  })

  const docs = await collectMarkdownFiles(input.sourceDir)
  let importedPages = 0

  for (const relativePath of docs) {
    const absolutePath = path.join(input.sourceDir, relativePath)
    const content = await readFile(absolutePath, 'utf8')
    const title = relativePath.replace(/\.md$/i, '')

    const child = await notionCreatePage({
      token: input.token,
      parentPageId: rawImportPage.id,
      title,
    })

    const blocks = content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 80)
      .map(line => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: line.slice(0, 1800),
              },
            },
          ],
        },
      }))

    if (blocks.length > 0) {
      await notionAppendChildren({
        token: input.token,
        blockId: child.id,
        children: blocks,
      })
    }

    importedPages += 1
  }

  return {
    stagePageId: rawImportPage.id,
    stagePageUrl: rawImportPage.url,
    importedPages,
  }
}

async function notionCreatePage(input: {
  token: string
  parentPageId?: string
  title: string
  asWorkspaceRoot?: boolean
}): Promise<{ id: string; url: string }> {
  const parent = input.asWorkspaceRoot
    ? { workspace: true }
    : { page_id: input.parentPageId }

  // DEBUG: Log parent object to verify correct parentPageId usage
  // eslint-disable-next-line no-console
  console.log('[notionCreatePage] parent object:', JSON.stringify(parent))

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

function getNotionPromptPack(): { prompt1: string; prompt2: string } {
  return {
    prompt1: [
      'You are reorganizing imported technical markdown into a polished, human-readable Notion knowledge workspace.',
      '',
      'Critical instructions:',
      '1) Do NOT keep the imported file/folder layout as-is.',
      '2) Reorganize by human information architecture, not by source filenames.',
      '3) Rewrite content for clarity and onboarding readability while preserving factual meaning.',
      '4) Keep source provenance: include "Source" references at section/page level when facts are specific.',
      '5) Preserve all important facts; remove duplication and merge overlapping notes.',
      '6) Produce top-level navigation: Overview, Getting Started / CLI Guide, Retrieval & Indexing, Policies & Decisions, Ticket Timeline, Archive.',
      '7) Keep a "Raw Import" sub-page untouched for rollback/audit.',
    ].join('\n'),
    prompt2: [
      'Perform a quality pass on the current Notion knowledge workspace.',
      '',
      'Goals:',
      '- Improve readability and flow for a new engineer with no prior context.',
      '- Reduce repetition across pages.',
      '- Ensure each top-level section includes purpose, key actions, and detail links.',
      '- Keep technical precision; do not invent behavior.',
    ].join('\n'),
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
