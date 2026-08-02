import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  runDocsDelete,
} from '@kb/core/cli/docs-delete-cli.js'
import { SqliteDocumentWriter } from '@kb/core/tools/sqlite-document-writer.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

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
  await writer.writeDocument({
    title: input.title,
    documentId: input.documentId,
    content: input.content,
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

describe('parseDocsDeleteCommand', () => {
  it('[TC-101] Given a doc id, then parses it', () => {
    const parsed = parseDocsDeleteCommand(['my-doc'])
    expect(parsed.documentId).toBe('my-doc')
    expect(parsed.isWildcard).toBe(false)
    expect(parsed.force).toBe(false)
    expect(parsed.base).toBeUndefined()
  })

  it('[TC-102] Given --force flag, then sets force true', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '--force'])
    expect(parsed.force).toBe(true)
  })

  it('[TC-103] Given -f shorthand, then sets force true', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '-f'])
    expect(parsed.force).toBe(true)
  })

  it('[TC-104] Given --base flag, then captures base', () => {
    const parsed = parseDocsDeleteCommand(['my-doc', '--base', 'dogfood'])
    expect(parsed.base).toBe('dogfood')
  })

  it('[TC-105] Given id with caps/spaces, then normalizes to slug', () => {
    const parsed = parseDocsDeleteCommand(['My Doc ID'])
    expect(parsed.documentId).toBe('my-doc-id')
    expect(parsed.isWildcard).toBe(false)
  })

  it('[TC-106] Given a wildcard pattern, then sets isWildcard true and preserves *', () => {
    const parsed = parseDocsDeleteCommand(['ci-*'])
    expect(parsed.documentId).toBe('ci-*')
    expect(parsed.isWildcard).toBe(true)
  })

  it('[TC-107] Given a wildcard pattern with caps, then lowercases and preserves *', () => {
    const parsed = parseDocsDeleteCommand(['CI-*'])
    expect(parsed.documentId).toBe('ci-*')
    expect(parsed.isWildcard).toBe(true)
  })

  it('[TC-108] Given a bare wildcard *, then isWildcard is true', () => {
    const parsed = parseDocsDeleteCommand(['*'])
    expect(parsed.isWildcard).toBe(true)
  })

  it('[TC-109] Given no args, then throws with exit code 0', () => {
    try {
      parseDocsDeleteCommand([])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsDeleteError)
      expect((e as DocsDeleteError).exitCode).toBe(0)
    }
  })

  it('[TC-110] Given --help, then throws with exit code 0', () => {
    try {
      parseDocsDeleteCommand(['--help'])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsDeleteError)
      expect((e as DocsDeleteError).exitCode).toBe(0)
    }
  })

  it('[TC-111] Given two positional args, then throws', () => {
    expect(() => parseDocsDeleteCommand(['doc-a', 'doc-b'])).toThrow(DocsDeleteError)
  })

  it('[TC-112] Given unknown flag, then throws', () => {
    expect(() => parseDocsDeleteCommand(['my-doc', '--unknown'])).toThrow(DocsDeleteError)
  })

  it('[TC-113] Given --base with no value, then throws', () => {
    expect(() => parseDocsDeleteCommand(['my-doc', '--base'])).toThrow(DocsDeleteError)
  })
})

// ─── runDocsDelete ────────────────────────────────────────────────────────────

describe('runDocsDelete', () => {
  it('[TC-114] Given --force and existing doc, then removes the document', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'To Delete', documentId: 'to-delete', content: 'Body.' })

    const { out } = makeOut()
    await runDocsDelete({ documentId: 'to-delete', isWildcard: false, force: true }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('to-delete')).toBeUndefined()
  })

  it('[TC-115] Given --force, then output confirms deletion with title and id', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'My Doc', documentId: 'my-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsDelete({ documentId: 'my-doc', isWildcard: false, force: true }, baseDir, out)

    const output = lines.join('\n')
    expect(output).toContain('My Doc')
    expect(output).toContain('my-doc')
  })

  it('[TC-116] Given --force, then other documents are unaffected', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Keep Me', documentId: 'keep-me', content: 'Body.' })
    await seedDocument(baseDir, { title: 'Delete Me', documentId: 'delete-me', content: 'Body.' })

    const { out } = makeOut()
    await runDocsDelete({ documentId: 'delete-me', isWildcard: false, force: true }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('keep-me')).toBeDefined()
  })

  it('[TC-117] Given non-existent doc id, then throws DocsDeleteError', async () => {
    const baseDir = await createTempBase()
    const { out } = makeOut()

    await expect(
      runDocsDelete({ documentId: 'does-not-exist', isWildcard: false, force: true }, baseDir, out)
    ).rejects.toThrow(DocsDeleteError)
  })

  it('[TC-118] Given non-interactive stdin and no --force, then aborts without deleting', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Safe Doc', documentId: 'safe-doc', content: 'Body.' })

    const { out, lines } = makeOut()
    // stdin.isTTY is falsy in test environment — promptConfirm returns false
    await runDocsDelete({ documentId: 'safe-doc', isWildcard: false, force: false }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('safe-doc')).toBeDefined()
    expect(lines.join('\n')).toContain('Aborted')
  })
})

// ─── runDocsDelete (wildcard) ─────────────────────────────────────────────────

describe('runDocsDelete (wildcard)', () => {
  it('[TC-119] Given a prefix wildcard, then deletes all matching documents', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'CI Alpha', documentId: 'ci-alpha', content: 'Body.' })
    await seedDocument(baseDir, { title: 'CI Beta', documentId: 'ci-beta', content: 'Body.' })
    await seedDocument(baseDir, { title: 'Keep Me', documentId: 'keep-me', content: 'Body.' })

    const { out } = makeOut()
    await runDocsDelete({ documentId: 'ci-*', isWildcard: true, force: true }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('ci-alpha')).toBeUndefined()
    expect(indexer.getDocumentContent('ci-beta')).toBeUndefined()
    expect(indexer.getDocumentContent('keep-me')).toBeDefined()
  })

  it('[TC-120] Given a wildcard match, then output lists matched ids and confirms each deletion', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'CI Alpha', documentId: 'ci-alpha', content: 'Body.' })
    await seedDocument(baseDir, { title: 'CI Beta', documentId: 'ci-beta', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsDelete({ documentId: 'ci-*', isWildcard: true, force: true }, baseDir, out)

    const output = lines.join('\n')
    expect(output).toContain('ci-alpha')
    expect(output).toContain('ci-beta')
    expect(output).toContain('Deleted')
  })

  it('[TC-121] Given a wildcard with no matches, then throws DocsDeleteError', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Keep Me', documentId: 'keep-me', content: 'Body.' })

    const { out } = makeOut()
    await expect(
      runDocsDelete({ documentId: 'ci-*', isWildcard: true, force: true }, baseDir, out)
    ).rejects.toThrow(DocsDeleteError)
  })

  it('[TC-122] Given wildcard and non-interactive stdin without --force, then aborts without deleting', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'CI Alpha', documentId: 'ci-alpha', content: 'Body.' })

    const { out, lines } = makeOut()
    await runDocsDelete({ documentId: 'ci-*', isWildcard: true, force: false }, baseDir, out)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    expect(indexer.getDocumentContent('ci-alpha')).toBeDefined()
    expect(lines.join('\n')).toContain('Aborted')
  })
})
