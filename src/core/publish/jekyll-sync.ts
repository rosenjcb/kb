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
  is_original: number
}

export interface JekyllSyncResult {
  jekyllRoot: string
  postsDir: string
  originalDocsDir: string
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
  const originalDocsDir = path.join(jekyllRoot, '_original_docs')
  const written: JekyllSyncResult['written'] = []
  const skipped: JekyllSyncResult['skipped'] = []

  if (dryRun) {
    const postSlugsSeen = new Set<string>()
    const originalSlugsSeen = new Set<string>()
    for (const doc of docs) {
      if (!doc.title?.trim()) {
        skipped.push({ id: doc.id, title: '', reason: 'no title' })
        continue
      }
      const filename = doc.is_original === 1
        ? deduplicateFilename(docToCollectionFilename(doc), originalSlugsSeen)
        : deduplicateFilename(docToFilename(doc), postSlugsSeen)
      ;(doc.is_original === 1 ? originalSlugsSeen : postSlugsSeen).add(filename)
      written.push({ id: doc.id, title: doc.title, filename })
    }
    return { jekyllRoot, postsDir, originalDocsDir, written, skipped }
  }

  await mkdir(postsDir, { recursive: true })
  await mkdir(originalDocsDir, { recursive: true })

  // Clear existing files in both directories
  for (const dir of [postsDir, originalDocsDir]) {
    const existing = await readdir(dir)
    await Promise.all(existing.filter(f => f.endsWith('.md')).map(f => rm(path.join(dir, f))))
  }

  const postSlugsSeen = new Set<string>()
  const originalSlugsSeen = new Set<string>()

  for (const doc of docs) {
    if (!doc.title?.trim()) {
      skipped.push({ id: doc.id, title: '', reason: 'no title' })
      continue
    }

    if (doc.is_original === 1) {
      const filename = deduplicateFilename(docToCollectionFilename(doc), originalSlugsSeen)
      originalSlugsSeen.add(filename)
      await writeFile(path.join(originalDocsDir, filename), buildJekyllFile(doc), 'utf8')
      written.push({ id: doc.id, title: doc.title, filename })
    } else {
      const filename = deduplicateFilename(docToFilename(doc), postSlugsSeen)
      postSlugsSeen.add(filename)
      await writeFile(path.join(postsDir, filename), buildJekyllFile(doc), 'utf8')
      written.push({ id: doc.id, title: doc.title, filename })
    }
  }

  const postEntries = written
    .filter(({ filename }) => !isCollectionFilename(filename))
    .map(({ title, filename }) => ({ title, filename }))

  const originalEntries = written
    .filter(({ filename }) => isCollectionFilename(filename))
    .map(({ title, filename }) => ({ title, filename }))

  await writePublishedPostsData(jekyllRoot, postEntries)
  await writeOriginalDocsData(jekyllRoot, originalEntries)

  return { jekyllRoot, postsDir, originalDocsDir, written, skipped }
}

export function docToFilename(doc: Pick<KbDocRow, 'title' | 'created_at'>): string {
  const date = doc.created_at.slice(0, 10) // YYYY-MM-DD
  const slug = slugify(doc.title)
  return `${date}-${slug}.md`
}

export function docToCollectionFilename(doc: Pick<KbDocRow, 'title'>): string {
  return `${slugify(doc.title)}.md`
}

function isCollectionFilename(filename: string): boolean {
  return !/^\d{4}-\d{2}-\d{2}-/.test(filename)
}

/**
 * Jekyll post URL path (no `baseurl`) for `_posts/YYYY-MM-DD-slug.md` when site uses
 * `permalink: /:year/:month/:day/:title.html` (see docs/_config.yml).
 */
export function filenameToPostUrlPath(filename: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/i.exec(filename)
  if (!m) {
    throw new Error(`Unexpected post filename (expected YYYY-MM-DD-slug.md): ${filename}`)
  }
  const [, y, mo, d, slug] = m
  return `/${y}/${mo}/${d}/${slug}.html`
}

export function filenameToCollectionUrlPath(filename: string): string {
  const slug = filename.replace(/\.md$/i, '')
  return `/${slug}.html`
}

const KB_PUBLISHED_POSTS_DATA = 'kb_published_posts.yml'
const KB_ORIGINAL_DOCS_DATA = 'kb_original_docs.yml'

async function writePublishedPostsData(
  jekyllRoot: string,
  entries: Array<{ title: string; filename: string }>
): Promise<void> {
  const dataDir = path.join(jekyllRoot, '_data')
  await mkdir(dataDir, { recursive: true })
  const posts = entries.map(({ title, filename }) => ({
    title,
    url: filenameToPostUrlPath(filename),
  }))
  const out = `# Auto-generated by kb publish jekyll — do not edit by hand\n${yaml.dump({ posts }, { lineWidth: -1 })}`
  await writeFile(path.join(dataDir, KB_PUBLISHED_POSTS_DATA), out, 'utf8')
}

async function writeOriginalDocsData(
  jekyllRoot: string,
  entries: Array<{ title: string; filename: string }>
): Promise<void> {
  const dataDir = path.join(jekyllRoot, '_data')
  await mkdir(dataDir, { recursive: true })
  const docs = entries.map(({ title, filename }) => ({
    title,
    url: filenameToCollectionUrlPath(filename),
  }))
  const out = `# Auto-generated by kb publish jekyll — do not edit by hand\n${yaml.dump({ docs }, { lineWidth: -1 })}`
  await writeFile(path.join(dataDir, KB_ORIGINAL_DOCS_DATA), out, 'utf8')
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
    layout: 'default',
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
