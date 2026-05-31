import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildJekyllFile,
  discoverJekyllRoot,
  docToCollectionFilename,
  filenameToCollectionUrlPath,
  formatJekyllPublishSnapshotDate,
  mapToJekyllFrontMatter,
  slugify,
  stripKbMetadataHeader,
  syncDocsToJekyll,
} from '../../src/core/publish/jekyll-sync'
import type { JekyllGraphPayload, KbDocRow } from '../../src/core/publish/jekyll-sync'

const makeDoc = (overrides: Partial<KbDocRow> = {}): KbDocRow => ({
  id: 'doc-1',
  title: 'My Test Document',
  content:
    '# My Test Document\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: a, b\n\n## Body\n\nHello world.',
  doc_type: 'architecture',
  tags_json: '["a","b"]',
  created_at: '2026-01-15T10:00:00.000Z',
  updated_at: '2026-01-15T10:00:00.000Z',
  is_original: 0,
  ...overrides,
})

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-jekyll-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('formatJekyllPublishSnapshotDate', () => {
  it('Given a local calendar instant, then formats YYYY-MM-DD only (no clock)', () => {
    const ms = new Date(2026, 1, 10, 23, 59, 59).getTime() // Feb 10 2026 local
    expect(formatJekyllPublishSnapshotDate(ms)).toBe('2026-02-10')
  })
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

describe('filenameToCollectionUrlPath', () => {
  it('Given a slug filename, then returns html URL path', () => {
    expect(filenameToCollectionUrlPath('my-test-document.md')).toBe('/my-test-document.html')
  })

  it('Given a deduplicated filename, then slug includes numeric suffix', () => {
    expect(filenameToCollectionUrlPath('my-test-document-2.md')).toBe('/my-test-document-2.html')
  })
})

describe('docToCollectionFilename', () => {
  it('Given a simple title, then returns slug.md', () => {
    const doc = makeDoc()
    expect(docToCollectionFilename(doc)).toBe('my-test-document.md')
  })

  it('Given a title with special chars, then slug is clean', () => {
    const doc = makeDoc({ title: 'API & Auth: The Reckoning' })
    expect(docToCollectionFilename(doc)).toBe('api-auth-the-reckoning.md')
  })

  it('Given a path-style title, then uses the full path as slug to avoid basename collisions', () => {
    const doc = makeDoc({ title: 'src/core/AGENT_LOOP.md' })
    expect(docToCollectionFilename(doc)).toBe('src-core-agent-loop.md')
  })

  it('Given a title ending in .md, then strips extension before slugifying', () => {
    const doc = makeDoc({ title: 'README.md' })
    expect(docToCollectionFilename(doc)).toBe('readme.md')
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
  const publishedAtMs = new Date(2026, 5, 1, 12, 0, 0).getTime() // June 1 2026 local

  it('Given a full doc, then maps layout, title, date, kb_id, tags, categories', () => {
    const fm = mapToJekyllFrontMatter(makeDoc(), { publishedAtMs })
    expect(fm.layout).toBe('default')
    expect(fm.title).toBe('My Test Document')
    expect(fm.date).toBe('2026-06-01')
    expect(fm.kb_id).toBe('doc-1')
    expect(fm.tags).toEqual(['a', 'b'])
    expect(fm.categories).toEqual(['architecture'])
  })

  it('Given SQLite created_at differs from publish time, then date still uses publish snapshot', () => {
    const fm = mapToJekyllFrontMatter(
      makeDoc({ created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z' }),
      { publishedAtMs }
    )
    expect(fm.date).toBe('2026-06-01')
  })

  it('Given a doc with no tags, then omits tags field', () => {
    const fm = mapToJekyllFrontMatter(makeDoc({ tags_json: null }), { publishedAtMs })
    expect(fm.tags).toBeUndefined()
  })

  it('Given a doc with no doc_type, then omits categories field', () => {
    const fm = mapToJekyllFrontMatter(makeDoc({ doc_type: null }), { publishedAtMs })
    expect(fm.categories).toBeUndefined()
  })
})

describe('buildJekyllFile', () => {
  const publishedAtMs = new Date(2026, 5, 1, 12, 0, 0).getTime()

  it('Given a doc, then output starts with YAML front matter block', () => {
    const output = buildJekyllFile(makeDoc(), { publishedAtMs })
    expect(output.startsWith('---\n')).toBe(true)
    expect(output).toContain('\n---\n')
    expect(output).toContain('layout: default')
    expect(output).toContain('title: My Test Document')
    expect(output).toContain("date: '2026-06-01'")
  })

  it('Given a doc, then body content appears after front matter', () => {
    const output = buildJekyllFile(makeDoc(), { publishedAtMs })
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
  const graphPayload: JekyllGraphPayload = {
    generatedAt: '2026-04-21T00:00:00.000Z',
    entities: [{ id: 'kb', name: 'KB', type: 'system' }],
    relationships: [],
  }

  beforeEach(async () => {
    jekyllRoot = path.join(tempDir, 'site')
    await mkdir(jekyllRoot)
    await writeFile(path.join(jekyllRoot, '_config.yml'), 'title: Test\n', 'utf8')
  })

  it('Given docs in preview mode, then returns written list without touching filesystem', async () => {
    const docs = [makeDoc(), makeDoc({ id: 'doc-2', title: 'Second Doc' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, false, graphPayload)

    expect(result.written).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
    await expect(readdir(path.join(jekyllRoot, '_autogenerated_docs'))).rejects.toThrow()
    await expect(readFile(path.join(jekyllRoot, 'graph.md'), 'utf8')).rejects.toThrow()
  })

  it('Given autogenerated docs in apply mode, then writes to _autogenerated_docs', async () => {
    const docs = [makeDoc()]
    const result = await syncDocsToJekyll(docs, jekyllRoot, true, graphPayload)

    expect(result.written).toHaveLength(1)
    expect(result.written[0].filename).toBe('my-test-document.md')

    const files = await readdir(path.join(jekyllRoot, '_autogenerated_docs'))
    expect(files).toContain('my-test-document.md')

    const dataYaml = await readFile(
      path.join(jekyllRoot, '_data', 'kb_autogenerated_docs.yml'),
      'utf8'
    )
    expect(dataYaml).toContain('url: /my-test-document.html')
    expect(dataYaml).toContain('title: My Test Document')

    const graphPage = await readFile(
      path.join(jekyllRoot, '_graph_pages', 'knowledge-graph.md'),
      'utf8'
    )
    expect(graphPage).toContain('Cytoscape.js')
    expect(graphPage).toContain('/assets/generated/kb-graph.json')

    const graphJson = await readFile(
      path.join(jekyllRoot, 'assets', 'generated', 'kb-graph.json'),
      'utf8'
    )
    expect(graphJson).toContain('"id": "kb"')
  })

  it('Given is_original docs, then routes them to _original_docs', async () => {
    const docs = [makeDoc({ is_original: 1 })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, true, graphPayload)

    expect(result.written).toHaveLength(1)
    const files = await readdir(path.join(jekyllRoot, '_original_docs'))
    expect(files).toContain('my-test-document.md')

    const dataYaml = await readFile(path.join(jekyllRoot, '_data', 'kb_original_docs.yml'), 'utf8')
    expect(dataYaml).toContain('title: My Test Document')
  })

  it('Given existing files, then clears them before writing and reports removed', async () => {
    const autogenDir = path.join(jekyllRoot, '_autogenerated_docs')
    await mkdir(autogenDir)
    await writeFile(path.join(autogenDir, 'old-doc.md'), 'stale', 'utf8')

    const result = await syncDocsToJekyll([makeDoc()], jekyllRoot, true, graphPayload)

    const files = await readdir(autogenDir)
    expect(files).not.toContain('old-doc.md')
    expect(result.removed).toEqual([{ filename: 'old-doc.md', lane: 'autogenerated' }])
  })

  it('Given preview mode with stale files on disk, then reports removed without writing', async () => {
    const autogenDir = path.join(jekyllRoot, '_autogenerated_docs')
    await mkdir(autogenDir)
    await writeFile(path.join(autogenDir, 'old-doc.md'), 'stale', 'utf8')

    const result = await syncDocsToJekyll([makeDoc()], jekyllRoot, false, graphPayload)

    expect(result.removed).toEqual([{ filename: 'old-doc.md', lane: 'autogenerated' }])
    expect(await readdir(autogenDir)).toContain('old-doc.md')
  })

  it('Given a doc with no title, then skips it with reason', async () => {
    const docs = [makeDoc({ title: '' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, true, graphPayload)

    expect(result.written).toHaveLength(0)
    expect(result.skipped[0].reason).toBe('no title')
  })

  it('Given two docs with the same title, then deduplicates filenames', async () => {
    const docs = [makeDoc(), makeDoc({ id: 'doc-2' })]
    const result = await syncDocsToJekyll(docs, jekyllRoot, true, graphPayload)

    const filenames = result.written.map(w => w.filename)
    expect(new Set(filenames).size).toBe(2)
    expect(filenames[1]).toBe('my-test-document-2.md')
  })

  it('Given docs, then written file contains valid YAML front matter and body', async () => {
    await syncDocsToJekyll([makeDoc()], jekyllRoot, true, graphPayload)

    const content = await readFile(
      path.join(jekyllRoot, '_autogenerated_docs', 'my-test-document.md'),
      'utf8'
    )
    expect(content).toContain('layout: default')
    expect(content).toContain('title: My Test Document')
    expect(content).toContain('## Body')
  })
})
