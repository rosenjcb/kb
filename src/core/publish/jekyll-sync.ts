import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'

export interface KbDocRow {
  id: string
  title: string
  content: string
  doc_type: string | null
  tags_json: string | null
  created_at: string
  updated_at: string
}

export interface JekyllSyncResult {
  jekyllRoot: string
  postsDir: string
  written: Array<{ id: string; title: string; filename: string }>
  skipped: Array<{ id: string; title: string; reason: string }>
}

export async function discoverJekyllRoot(dir: string): Promise<string> {
  const candidates = [dir, path.join(dir, 'docs')]
  for (const candidate of candidates) {
    try {
      await stat(path.join(candidate, '_config.yml'))
      return candidate
    } catch {
      // not here, try next
    }
  }
  throw new Error(
    `No Jekyll project found. Looked for _config.yml in:\n  ${candidates.join('\n  ')}`
  )
}

export async function syncDocsToJekyll(
  docs: KbDocRow[],
  jekyllRoot: string,
  dryRun = false
): Promise<JekyllSyncResult> {
  const postsDir = path.join(jekyllRoot, '_posts')
  const written: JekyllSyncResult['written'] = []
  const skipped: JekyllSyncResult['skipped'] = []

  if (dryRun) {
    const slugsSeen = new Set<string>()
    for (const doc of docs) {
      if (!doc.title?.trim()) {
        skipped.push({ id: doc.id, title: '', reason: 'no title' })
        continue
      }
      const filename = deduplicateFilename(docToFilename(doc), slugsSeen)
      slugsSeen.add(filename)
      written.push({ id: doc.id, title: doc.title, filename })
    }
    return { jekyllRoot, postsDir, written, skipped }
  }

  await mkdir(postsDir, { recursive: true })

  const existing = await readdir(postsDir)
  await Promise.all(
    existing
      .filter(f => f.endsWith('.md'))
      .map(f => rm(path.join(postsDir, f)))
  )

  const slugsSeen = new Set<string>()
  for (const doc of docs) {
    if (!doc.title?.trim()) {
      skipped.push({ id: doc.id, title: '', reason: 'no title' })
      continue
    }
    const filename = deduplicateFilename(docToFilename(doc), slugsSeen)
    slugsSeen.add(filename)
    await writeFile(path.join(postsDir, filename), buildJekyllFile(doc), 'utf8')
    written.push({ id: doc.id, title: doc.title, filename })
  }

  return { jekyllRoot, postsDir, written, skipped }
}

export function docToFilename(doc: Pick<KbDocRow, 'title' | 'created_at'>): string {
  const date = doc.created_at.slice(0, 10) // YYYY-MM-DD
  const slug = slugify(doc.title)
  return `${date}-${slug}.md`
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function buildJekyllFile(doc: KbDocRow): string {
  const frontMatter = mapToJekyllFrontMatter(doc)
  const body = stripKbMetadataHeader(doc.content)
  return `---\n${yaml.dump(frontMatter, { lineWidth: -1 }).trimEnd()}\n---\n\n${body.trimStart()}`
}

export function mapToJekyllFrontMatter(doc: KbDocRow): Record<string, unknown> {
  const tags = parseTags(doc.tags_json)
  const fm: Record<string, unknown> = {
    title: doc.title,
    date: doc.created_at.slice(0, 19).replace('T', ' '),
    kb_id: doc.id,
  }
  if (tags.length > 0) fm.tags = tags
  if (doc.doc_type) fm.categories = [doc.doc_type]
  return fm
}

export function stripKbMetadataHeader(content: string): string {
  const lines = content.split('\n')
  let i = 0

  // skip H1 title line
  if (lines[i]?.startsWith('# ')) i++

  // skip blank lines then metadata key-value lines (Created:, Type:, Tags:)
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (/^(Created|Type|Tags): /.test(line)) {
      i++
      continue
    }
    break
  }

  return lines.slice(i).join('\n')
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return []
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function deduplicateFilename(base: string, seen: Set<string>): string {
  if (!seen.has(base)) return base
  const ext = path.extname(base)
  const stem = base.slice(0, -ext.length)
  let n = 2
  while (seen.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}
