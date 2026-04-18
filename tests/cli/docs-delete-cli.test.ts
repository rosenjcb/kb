import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  runDocsDelete,
} from '../../src/cli/docs-delete-cli'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-delete-cli-'))
  tempDirs.push(dir)
  return dir
}

async function seedDocument(
  baseDir: string,
  input: { title: string; documentId?: string; content: string }
): Promise<void> {
  const writer = new SqliteDocumentWriter({ baseDir })
  await writer.writeDocument({ title: input.title, documentId: input.documentId, content: input.content })
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

describe('parseDocsDeleteCommand', () => {
  it('Given a doc id, then parses it', () => {
    const parsed = parseDocsDeleteCommand(['my-doc'])
    expect(parsed.documentId).toBe('my-doc')
    expect(parsed.force).toBe(false)
    expect(parsed.base).toBeUndefined()
  })

  it('Given --force flag, then sets force true', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '--force'])
    expect(parsed.force).toBe(true)
  })

  it('Given -f shorthand, then sets force true', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '-f'])
    expect(parsed.force).toBe(true)
  })

  it('Given --base flag, then captures base', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '--base', 'dogfood'])
    expect(parsed.base).toBe('dogfood')
  })

  it('Given id with caps/spaces, then normalizes to slug', () => {
    const parsed = parseDocsDeleteCommand(['My Doc ID'])
    expect(parsed.documentId).toBe('my-doc-id')
  })

  it('Given no args, then throws with exit code 0', () => {
    try {
      parseDocsDeleteCommand([])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsDeleteError)
      expect((e as DocsDeleteError).exitCode).toBe(0)
    }
  })

  it('Given --help, then throws with exit code 0', () => {
    try {
      parseDocsDeleteCommand(['--help'])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsDeleteError)
      expect((e as DocsDeleteError).exitCode).toBe(0)
    }
  })

  it('Given two positional args, then throws', () => {
    expect(() => parseDocsDeleteCommand(['doc-a', 'doc-b'])).toThrow(DocsDeleteError)
  })

  it('Given unknown flag, then throws', () => {
    expect(() => parseDocsDeleteCommand(['my-doc', '--unknown'])).toThrow(DocsDeleteError)
  })

  it('Given --base with no value, then throws', () => {
    expect(() => parseDocsDeleteCommand(['my-doc', '--base'])).toThrow(DocsDeleteError)
  })
})

// ─── runDocsDelete ────────────────────────────────────────────────────────────

describe('runDocsDelete', () => {
  it('Given --force and existing doc, then removes the document', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'To Delete', documentId: 'to-delete', content: 'Body.' })

    const { out } = makeOut()
    await runDocsDelete({ documentId: 'to-delete', force: true }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('to-delete')).toBeUndefined()
  })

  it('Given --force, then output confirms deletion with title and id', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'My Doc', documentId: 'my-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsDelete({ documentId: 'my-doc', force: true }, baseDir, out)

    const output = lines.join('\n')
    expect(output).toContain('My Doc')
    expect(output).toContain('my-doc')
  })

  it('Given --force, then other documents are unaffected', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Keep Me', documentId: 'keep-me', content: 'Body.' })
    await seedDocument(baseDir, { title: 'Delete Me', documentId: 'delete-me', content: 'Body.' })

    const { out } = makeOut()
    await runDocsDelete({ documentId: 'delete-me', force: true }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('keep-me')).toBeDefined()
  })

  it('Given non-existent doc id, then throws DocsDeleteError', async () => {
    const baseDir = await createTempBase()
    const { out } = makeOut()

    await expect(
      runDocsDelete({ documentId: 'does-not-exist', force: true }, baseDir, out)
    ).rejects.toThrow(DocsDeleteError)
  })

  it('Given non-interactive stdin and no --force, then aborts without deleting', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Safe Doc', documentId: 'safe-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    // stdin.isTTY is falsy in test environment — promptConfirm returns false
    await runDocsDelete({ documentId: 'safe-doc', force: false }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('safe-doc')).toBeDefined()
    expect(lines.join('\n')).toContain('Aborted')
  })
})
