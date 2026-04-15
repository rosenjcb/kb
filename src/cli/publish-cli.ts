import path from 'node:path'
import dayjs from 'dayjs'
import Database from 'better-sqlite3'
import { resolveBaseToDir, resolveEffectiveBaseDir } from './base-selection'
import { readKbConfig, resolveNotionToken } from './kb-config'

export type PublishPhase = 'all'
export type PublishStopPoint = 'package' | 'import'

export interface PublishOptions {
  base?: string
  provider: 'notion'
  apply: boolean
  dryRun: boolean
  parentPageId?: string
  checkpointFile?: string
  resumeFrom?: string
  stopAfter?: PublishStopPoint
}

interface SqliteDocumentRow {
  id: string
  title: string
  content: string
  doc_type: string | null
  lane: string | null
  tags_json: string | null
  created_at: string
  updated_at: string
}

export interface PublishResult {
  status: 'accepted' | 'dry-run'
  apply: boolean
  provider: 'notion'
  baseName: string
  baseDir: string
  totalDocs: number
  publishedPages: Array<{ id: string; title: string; notionPageId?: string; notionUrl?: string }>
  warnings: string[]
}

const NOTION_VERSION = '2022-06-28'

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
  const hasApply = readFlag(args, '--apply')
  const hasDryRun = readFlag(args, '--dry-run')
  if (hasApply && hasDryRun) {
    throw new Error('Use either --apply or --dry-run, not both')
  }

  const stopAfter = readOption(args, '--stop-after')?.trim().toLowerCase() as PublishStopPoint | undefined
  if (stopAfter && !['package', 'import'].includes(stopAfter)) {
    throw new Error('Invalid --stop-after. Use package|import')
  }

  return {
    base: readOption(args, '--base'),
    provider: 'notion',
    apply: hasApply,
    dryRun: hasDryRun || !hasApply,
    parentPageId: readOption(args, '--parent-page-id'),
    checkpointFile: readOption(args, '--checkpoint-file'),
    resumeFrom: readOption(args, '--resume-from'),
    stopAfter,
  }
}

export async function runPublishCommand(
  options: PublishOptions,
  cwd: string = process.cwd(),
): Promise<PublishResult> {
  const config = await readKbConfig()
  const baseResolution = await resolvePublishBase(options.base, cwd)
  const warnings: string[] = []

  const token = options.apply ? resolveNotionToken(config) : undefined
  if (options.apply && !token) {
    throw new Error(
      'Missing Notion token. Set notion.token in ~/.kb/config.json or NOTION_TOKEN/NOTION_API_KEY in env.',
    )
  }

  const parentPageId = options.parentPageId
    ?? config.notion?.parentPageId
    ?? process.env.NOTION_PARENT_PAGE_ID

  if (options.apply && !parentPageId) {
    throw new Error(
      'Missing Notion parent page ID. Set notion.parentPageId in ~/.kb/config.json or --parent-page-id flag.',
    )
  }

  // Read documents from SQLite
  const sqliteDbPath = path.join(baseResolution.baseDir, '.kb-index.sqlite')
  const docs = readDocumentsFromSqlite(sqliteDbPath)

  if (docs.length === 0) {
    warnings.push('No documents found in SQLite database. Run `kb init` to populate.')
  }

  const progress = new PublishProgressReporter(docs.length)
  progress.start('reading docs', `${docs.length} documents`)

  const publishedPages: PublishResult['publishedPages'] = []

  if (options.dryRun) {
    // Dry-run: show what would be published
    for (const doc of docs) {
      publishedPages.push({ id: doc.id, title: doc.title })
      progress.finish('dry-run', doc.title)
    }

    return {
      status: 'dry-run',
      apply: false,
      provider: 'notion',
      baseName: baseResolution.baseName,
      baseDir: baseResolution.baseDir,
      totalDocs: docs.length,
      publishedPages,
      warnings,
    }
  }

  // Create a parent page for this base's documents
  const runTimestamp = dayjs().format('YYYY-MM-DD HH:mm')
  const containerPage = await notionCreatePage({
    token: token!,
    parentPageId: parentPageId!,
    title: `${baseResolution.baseName} — ${runTimestamp}`,
  })

  progress.update('created container page', containerPage.url)

  // Publish each document as a child page
  for (const doc of docs) {
    progress.start('publishing', doc.title)

    try {
      const page = await notionCreatePage({
        token: token!,
        parentPageId: containerPage.id,
        title: doc.title,
        markdown: doc.content,
      })

      publishedPages.push({
        id: doc.id,
        title: doc.title,
        notionPageId: page.id,
        notionUrl: page.url,
      })

      progress.finish('published', doc.title)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Failed to publish "${doc.title}": ${msg}`)
      progress.finish('failed', doc.title)
    }
  }

  return {
    status: 'accepted',
    apply: true,
    provider: 'notion',
    baseName: baseResolution.baseName,
    baseDir: baseResolution.baseDir,
    totalDocs: docs.length,
    publishedPages,
    warnings,
  }
}

// ─── SQLite read ────────────────────────────────────────────────────────────

function readDocumentsFromSqlite(dbPath: string): SqliteDocumentRow[] {
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    return db.prepare(`
      SELECT id, title, content, doc_type, lane, tags_json, created_at, updated_at
      FROM documents
      WHERE content != ''
      ORDER BY updated_at DESC
    `).all() as SqliteDocumentRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot read SQLite at ${dbPath}: ${msg}`)
  } finally {
    db?.close()
  }
}

// ─── Notion API ─────────────────────────────────────────────────────────────

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
      ...(input.markdown ? { markdown: input.markdown } : {}),
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 400 && body.includes('public integration')) {
      throw new Error(
        'Notion workspace-root page creation is not supported for internal integrations. ' +
        'Set notion.parentPageId in ~/.kb/config.json.',
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

// ─── Config & resolution helpers ─────────────────────────────────────────────

async function resolvePublishBase(
  base: string | undefined,
  cwd: string,
): Promise<{ baseName: string; baseDir: string }> {
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

// ─── Arg parsing helpers ──────────────────────────────────────────────────────

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
