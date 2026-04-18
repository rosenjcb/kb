import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildJekyllFile,
  discoverJekyllRoot,
  docToFilename,
  filenameToPostUrlPath,
  mapToJekyllFrontMatter,
  slugify,
  stripKbMetadataHeader,
  syncDocsToJekyll,
} from '../../src/core/publish/jekyll-sync'
import type { KbDocRow } from '../../src/core/publish/jekyll-sync'

const makeDoc = (overrides: Partial<KbDocRow> = {}): KbDocRow => ({
  id: 'doc-1',
  title: 'My Test Document',
  content: '# My Test Document\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: a, b\n\n## Body\n\nHello world.',
  doc_type: 'architecture',
  tags_json: '["a","b"]',
  created_at: '2026-01-15T10:00:00.000Z',
  updated_at: '2026-01-15T10:00:00.000Z',
  ...overrides,
})

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-jekyll-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('slugify', () => {
  it('Given a normal title, then lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('Given special characters, then strips them', () => {
    expect(slugify('Hello, World! 2026')).toBe('hello-world-2026')
  })

  it('Given leading and trailing spaces, then trims hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello')
  })

  it('Given a very long title, then truncates to 80 chars', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(80)
  })
})

describe('filenameToPostUrlPath', () => {
  it('Given a standard post filename, then returns Jekyll date permalink path', () => {
    expect(filenameToPostUrlPath('2026-01-15-my-test-document.md')).toBe('/2026/01/15/my-test-document.html')
  })

  it('Given a deduplicated filename, then slug includes numeric suffix', () => {
    expect(filenameToPostUrlPath('2026-01-15-my-test-document-2.md')).toBe('/2026/01/15/my-test-document-2.html')
  })
})

describe('docToFilename', () => {
  it('Given a doc with title and created_at, then returns YYYY-MM-DD-slug.md', () => {
    const doc = makeDoc()
    expect(docToFilename(doc)).toBe('2026-01-15-my-test-document.md')
  })

  it('Given a title with special chars, then slug is clean', () => {
    const doc = makeDoc({ title: 'API & Auth: The Reckoning' })
    expect(docToFilename(doc)).toBe('2026-01-15-api-auth-the-reckoning.md')
  })
})

describe('stripKbMetadataHeader', () => {
  it('Given full KB content, then strips H1, Created, Type, Tags lines', () => {
    const content =
      '# My Doc\n\nCreated: 2026-01-01T00:00:00Z\nType: architecture\nTags: a, b\n\n## Section\n\nBody text.'
    const result = stripKbMetadataHeader(content)
    expect(result).not.toContain('# My Doc')
    expect(result).not.toContain('Created:')
    expect(result).not.toContain('Type:')
    expect(result).not.toContain('Tags:')
    expect(result).toContain('## Section')
    expect(result).toContain('Body text.')
  })

  it('Given content with no metadata header, then returns content unchanged', () => {
    const content = '## Just a section\n\nSome text.'
    expect(stripKbMetadataHeader(content).trim()).toBe(content.trim())
  })

  it('Given content with only H1 and body, then strips just the title', () => {
    const content = '# Title\n\n## Body\n\nText.'
    const result = stripKbMetadataHeader(content)
    expect(result).not.toContain('# Title')
    expect(result).toContain('## Body')
  })
})

describe('mapToJekyllFrontMatter', () => {
  it('Given a full doc, then maps layout, title, date, kb_id, tags, categories', () => {
    const fm = mapToJekyllFrontMatter(makeDoc())
    expect(fm.layout).toBe('default')
    expect(fm.title).toBe('My Test Document')
    expect(fm.date).toBe('2026-01-15 10:00:00')
    expect(fm.kb_id).toBe('doc-1')
    expect(fm.tags).toEqual(['a', 'b'])
    expect(fm.categories).toEqual(['architecture'])
  })

  it('Given a doc with no tags, then omits tags field', () => {
    const fm = mapToJekyllFrontMatter(makeDoc({ tags_json: null }))
    expect(fm.tags).toBeUndefined()
  })

  it('Given a doc with no doc_type, then omits categories field', () => {
    const fm = mapToJekyllFrontMatter(makeDoc({ doc_type: null }))
    expect(fm.categories).toBeUndefined()
  })
})

describe('buildJekyllFile', () => {
  it('Given a doc, then output starts with YAML front matter block', () => {
    const output = buildJekyllFile(makeDoc())
    expect(output.startsWith('---\n')).toBe(true)
    expect(output).toContain('\n---\n')
    expect(output).toContain('layout: default')
    expect(output).toContain('title: My Test Document')
  })

  it('Given a doc, then body content appears after front matter', () => {
    const output = buildJekyllFile(makeDoc())
    const afterFrontMatter = output.split('---\n').slice(2).join('---\n')
    expect(afterFrontMatter).toContain('## Body')
    expect(afterFrontMatter).toContain('Hello world.')
  })
})

describe('discoverJekyllRoot', () => {
  it('Given _config.yml in dir, then returns dir as Jekyll root', async () => {
    await writeFile(path.join(tempDir, '_config.yml'), 'title: Test\n', 'utf8')
    const root = await discoverJekyllRoot(tempDir)
    expect(root).toBe(tempDir)
  })

  it('Given _config.yml in docs subdir, then returns docs subdir as Jekyll root', async () => {
    const docsDir = path.join(tempDir, 'docs')
    await mkdir(docsDir)
    await writeFile(path.join(docsDir, '_config.yml'), 'title: Test\n', 'utf8')
    const root = await discoverJekyllRoot(tempDir)
    expect(root).toBe(docsDir)
  })

  it('Given no _config.yml anywhere, then throws with helpful message', async () => {
    await expect(discoverJekyllRoot(tempDir)).rejects.toThrow('No Jekyll project found')
  })
})

describe('syncDocsToJekyll', () => {
  let jekyllRoot: string

  beforeEach(async () => {
    jekyllRoot = path.join(tempDir, 'site')
    await mkdir(jekyllRoot)
    await writeFile(path.join(jekyllRoot, '_config.yml'), 'title: Test\n', 'utf8')
  })

  it('Given docs in dry-run mode, then returns written list without touching filesystem', async () => {
    const docs = [makeDoc(), makeDoc({ id: 'doc-2', title: 'Second Doc' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, true)

    expect(result.written).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
    // no _posts dir created in dry-run
    await expect(readdir(path.join(jekyllRoot, '_posts'))).rejects.toThrow()
  })

  it('Given docs in apply mode, then writes .md files to _posts', async () => {
    const docs = [makeDoc()]
    const result = await syncDocsToJekyll(docs, jekyllRoot, false)

    expect(result.written).toHaveLength(1)
    expect(result.written[0].filename).toBe('2026-01-15-my-test-document.md')

    const files = await readdir(path.join(jekyllRoot, '_posts'))
    expect(files).toContain('2026-01-15-my-test-document.md')

    const dataPath = path.join(jekyllRoot, '_data', 'kb_published_posts.yml')
    const dataYaml = await readFile(dataPath, 'utf8')
    expect(dataYaml).toContain('url: /2026/01/15/my-test-document.html')
    expect(dataYaml).toContain('title: My Test Document')
  })

  it('Given existing _posts files, then clears them before writing', async () => {
    const postsDir = path.join(jekyllRoot, '_posts')
    await mkdir(postsDir)
    await writeFile(path.join(postsDir, 'old-post.md'), 'stale', 'utf8')

    await syncDocsToJekyll([makeDoc()], jekyllRoot, false)

    const files = await readdir(postsDir)
    expect(files).not.toContain('old-post.md')
  })

  it('Given a doc with no title, then skips it with reason', async () => {
    const docs = [makeDoc({ title: '' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, false)

    expect(result.written).toHaveLength(0)
    expect(result.skipped[0].reason).toBe('no title')
  })

  it('Given two docs with same date and title, then deduplicates filenames', async () => {
    const docs = [makeDoc(), makeDoc({ id: 'doc-2' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, false)

    const filenames = result.written.map(w => w.filename)
    expect(new Set(filenames).size).toBe(2)
    expect(filenames[1]).toBe('2026-01-15-my-test-document-2.md')
  })

  it('Given docs, then written file contains valid YAML front matter and body', async () => {
    await syncDocsToJekyll([makeDoc()], jekyllRoot, false)

    const content = await readFile(
      path.join(jekyllRoot, '_posts', '2026-01-15-my-test-document.md'),
      'utf8'
    )
    expect(content).toContain('layout: default')
    expect(content).toContain('title: My Test Document')
    expect(content).toContain('## Body')
  })
})
