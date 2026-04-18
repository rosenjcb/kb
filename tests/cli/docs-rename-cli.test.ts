import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  runDocsRename,
} from '../../src/cli/docs-rename-cli'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-rename-cli-'))
  tempDirs.push(dir)
  return dir
}

async function seedDocument(
  baseDir: string,
  input: {
    title: string
    documentId?: string
    content: string
    type?: 'architecture' | 'decision' | 'checklist' | 'runbook' | 'reference'
    tags?: string[]
  }
): Promise<void> {
  const writer = new SqliteDocumentWriter({ baseDir })
  await writer.writeDocument({
    title: input.title,
    documentId: input.documentId,
    content: input.content,
    type: input.type,
    tags: input.tags,
  })
}

function makeOut() {
  const lines: string[] = []
  return {
    out: {
      log: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      write: (m: string) => lines.push(m),
    },
    lines,
  }
}

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('parseDocsRenameCommand', () => {
  it('Given doc id and new title, then parses both', () => {
    const parsed = parseDocsRenameCommand(['my-doc', 'New Title'])
    expect(parsed.documentId).toBe('my-doc')
    expect(parsed.newTitle).toBe('New Title')
    expect(parsed.base).toBeUndefined()
  })

  it('Given --base flag, then captures base', () => {
    const parsed = parseDocsRenameCommand(['my-doc', 'New Title', '--base', 'dogfood'])
    expect(parsed.base).toBe('dogfood')
  })

  it('Given doc id with caps/spaces, then normalizes to slug', () => {
    const parsed = parseDocsRenameCommand(['My Doc ID', 'New Title'])
    expect(parsed.documentId).toBe('my-doc-id')
  })

  it('Given no args, then throws with exit code 0', () => {
    try {
      parseDocsRenameCommand([])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsRenameError)
      expect((e as DocsRenameError).exitCode).toBe(0)
    }
  })

  it('Given --help, then throws with exit code 0', () => {
    try {
      parseDocsRenameCommand(['--help'])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsRenameError)
      expect((e as DocsRenameError).exitCode).toBe(0)
    }
  })

  it('Given only one positional arg, then throws', () => {
    expect(() => parseDocsRenameCommand(['only-id'])).toThrow(DocsRenameError)
  })

  it('Given three positional args, then throws with wrapping hint', () => {
    expect(() => parseDocsRenameCommand(['id', 'word1', 'word2'])).toThrow(DocsRenameError)
  })

  it('Given empty string as new title, then throws', () => {
    expect(() => parseDocsRenameCommand(['my-doc', '   '])).toThrow(DocsRenameError)
  })

  it('Given unknown flag, then throws', () => {
    expect(() => parseDocsRenameCommand(['my-doc', 'Title', '--unknown'])).toThrow(DocsRenameError)
  })
})

// ─── runDocsRename ────────────────────────────────────────────────────────────

describe('runDocsRename', () => {
  it('Given existing doc, then updates title in stored content', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body text.' })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const content = indexer.getDocumentContent('my-doc') ?? ''
    expect(content).toContain('# New Title')
    expect(content).not.toContain('# Old Title')
  })

  it('Given existing doc, then doc id is unchanged', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body.' })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'Brand New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('my-doc')).toBeDefined()
  })

  it('Given existing doc, then body content is preserved', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Old Title',
      documentId: 'my-doc',
      content: 'Important body content that must survive.',
    })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const content = indexer.getDocumentContent('my-doc') ?? ''
    expect(content).toContain('Important body content that must survive.')
  })

  it('Given existing doc with tags and type, then metadata is preserved', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Old Title',
      documentId: 'my-doc',
      content: 'Body.',
      type: 'architecture',
      tags: ['core', 'infra'],
    })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const content = indexer.getDocumentContent('my-doc') ?? ''
    expect(content).toContain('Type: architecture')
    expect(content).toContain('Tags: core, infra')
  })

  it('Given existing doc, then output confirms old and new title', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    expect(lines.join('\n')).toContain('Old Title')
    expect(lines.join('\n')).toContain('New Title')
  })

  it('Given non-existent doc id, then throws DocsRenameError', async () => {
    const baseDir = await createTempBase()
    const { out } = makeOut()

    await expect(
      runDocsRename({ documentId: 'does-not-exist', newTitle: 'New Title' }, baseDir, out)
    ).rejects.toThrow(DocsRenameError)
  })
})
