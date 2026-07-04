import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  runDocsRename,
} from '@kb/client/cli/docs-rename-cli.js'
import { SqliteDocumentWriter } from '@kb/core/tools/sqlite-document-writer.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

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
    type?: 'howto' | 'introduction' | 'reference' | 'decision' | 'runbook'
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
  it('[TC-197] Given doc id and new title, then parses both', () => {
    const parsed = parseDocsRenameCommand(['my-doc', 'New Title'])
    expect(parsed.documentId).toBe('my-doc')
    expect(parsed.newTitle).toBe('New Title')
    expect(parsed.base).toBeUndefined()
  })

  it('[TC-198] Given --base flag, then captures base', () => {
    const parsed = parseDocsRenameCommand(['my-doc', 'New Title', '--base', 'dogfood'])
    expect(parsed.base).toBe('dogfood')
  })

  it('[TC-199] Given doc id with caps/spaces, then normalizes to slug', () => {
    const parsed = parseDocsRenameCommand(['My Doc ID', 'New Title'])
    expect(parsed.documentId).toBe('my-doc-id')
  })

  it('[TC-200] Given no args, then throws with exit code 0', () => {
    try {
      parseDocsRenameCommand([])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsRenameError)
      expect((e as DocsRenameError).exitCode).toBe(0)
    }
  })

  it('[TC-201] Given --help, then throws with exit code 0', () => {
    try {
      parseDocsRenameCommand(['--help'])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsRenameError)
      expect((e as DocsRenameError).exitCode).toBe(0)
    }
  })

  it('[TC-202] Given only one positional arg, then throws', () => {
    expect(() => parseDocsRenameCommand(['only-id'])).toThrow(DocsRenameError)
  })

  it('[TC-203] Given three positional args, then throws with wrapping hint', () => {
    expect(() => parseDocsRenameCommand(['id', 'word1', 'word2'])).toThrow(DocsRenameError)
  })

  it('[TC-204] Given empty string as new title, then throws', () => {
    expect(() => parseDocsRenameCommand(['my-doc', '   '])).toThrow(DocsRenameError)
  })

  it('[TC-205] Given unknown flag, then throws', () => {
    expect(() => parseDocsRenameCommand(['my-doc', 'Title', '--unknown'])).toThrow(DocsRenameError)
  })
})

// ─── runDocsRename ────────────────────────────────────────────────────────────

describe('runDocsRename', () => {
  it('[TC-206] Given existing doc, then updates title in stored content', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body text.' })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const content = indexer.getDocumentContent('my-doc') ?? ''
    expect(content).toContain('# New Title')
    expect(content).not.toContain('# Old Title')
  })

  it('[TC-207] Given existing doc, then doc id is unchanged', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body.' })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'Brand New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('my-doc')).toBeDefined()
  })

  it('[TC-208] Given existing doc, then body content is preserved', async () => {
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

  it('[TC-209] Given existing doc with tags and type, then metadata is preserved', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Old Title',
      documentId: 'my-doc',
      content: 'Body.',
      type: 'introduction',
      tags: ['core', 'infra'],
    })

    const { out } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    const content = indexer.getDocumentContent('my-doc') ?? ''
    expect(content).toContain('Type: introduction')
    expect(content).toContain('Tags: core, infra')
  })

  it('[TC-210] Given existing doc, then output confirms old and new title', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Old Title', documentId: 'my-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsRename({ documentId: 'my-doc', newTitle: 'New Title' }, baseDir, out)

    expect(lines.join('\n')).toContain('Old Title')
    expect(lines.join('\n')).toContain('New Title')
  })

  it('[TC-211] Given non-existent doc id, then throws DocsRenameError', async () => {
    const baseDir = await createTempBase()
    const { out } = makeOut()

    await expect(
      runDocsRename({ documentId: 'does-not-exist', newTitle: 'New Title' }, baseDir, out)
    ).rejects.toThrow(DocsRenameError)
  })
})
