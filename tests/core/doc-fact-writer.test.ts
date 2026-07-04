import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  docFactSourceRefPrefix,
  tombstoneDocFactsForFile,
  tombstoneRemovedDocSourceFiles,
} from '@kb/core/core/doc-fact-writer.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('docFactSourceRefPrefix', () => {
  it('[TC-12] appends # for segment refs', () => {
    expect(docFactSourceRefPrefix('README.md')).toBe('README.md#')
    expect(docFactSourceRefPrefix('docs/guide.md')).toBe('docs/guide.md#')
  })
})

describe('tombstoneDocFactsForFile', () => {
  it('[TC-13] removes import_doc segment facts for a file and ignores other source kinds', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-fact-tombstone-'))
    tempDirs.push(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    try {
      indexer.upsertFact({
        factText: 'Stale sentence one that should be removed from the knowledge base entirely.',
        sourceKind: 'import_doc',
        sourceRef: 'README.md#s0',
        confidence: 0.55,
      })
      indexer.upsertFact({
        factText: 'Stale sentence two that should also be removed when the file is rescanned.',
        sourceKind: 'import_doc',
        sourceRef: 'README.md#s1',
        confidence: 0.55,
      })
      indexer.upsertFact({
        factText: 'parseScanCommand is exported from src/cli/init-cli.ts',
        sourceKind: 'import_code',
        sourceRef: 'ast:README.md#s0',
        confidence: 0.7,
      })
      indexer.upsertFact({
        factText: 'Unrelated doc sentence kept because it belongs to a different markdown file.',
        sourceKind: 'import_doc',
        sourceRef: 'OTHER.md#s0',
        confidence: 0.55,
      })

      const removed = tombstoneDocFactsForFile(indexer, 'README.md')
      expect(removed).toBe(2)
      expect(indexer.listActiveFactsBySourceRefPrefix('README.md#').length).toBe(0)
      expect(indexer.listActiveFactsBySourceRefPrefix('OTHER.md#').length).toBe(1)
      expect(indexer.listActiveFactsBySourceRefPrefix('ast:README.md#').length).toBe(1)
    } finally {
      indexer.close()
    }
  })

  it('[TC-14] returns zero when the file has no segment facts', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-fact-tombstone-empty-'))
    tempDirs.push(baseDir)
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      expect(tombstoneDocFactsForFile(indexer, 'missing.md')).toBe(0)
    } finally {
      indexer.close()
    }
  })
})

describe('tombstoneRemovedDocSourceFiles', () => {
  it('[TC-15] purges facts for paths dropped from the manifest', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-fact-removed-'))
    tempDirs.push(baseDir)
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      indexer.upsertFact({
        factText: 'Old guide sentence that should disappear when the markdown file is deleted.',
        sourceKind: 'import_doc',
        sourceRef: 'docs/old.md#s0',
        confidence: 0.55,
      })
      indexer.upsertFact({
        factText: 'Current readme sentence that should remain after rescan manifest diff.',
        sourceKind: 'import_doc',
        sourceRef: 'README.md#s0',
        confidence: 0.55,
      })

      const purged = tombstoneRemovedDocSourceFiles(
        indexer,
        { 'README.md': '# stay\n' },
        {
          version: 1,
          files: { 'README.md': 'hash-a', 'docs/old.md': 'hash-b' },
          updatedAt: '',
        }
      )
      expect(purged).toBe(1)
      expect(indexer.listActiveFactsBySourceRefPrefix('docs/old.md#').length).toBe(0)
      expect(indexer.listActiveFactsBySourceRefPrefix('README.md#').length).toBe(1)
    } finally {
      indexer.close()
    }
  })

  it('[TC-16] returns zero when manifest is empty or nothing was removed', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-fact-removed-none-'))
    tempDirs.push(baseDir)
    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      expect(
        tombstoneRemovedDocSourceFiles(indexer, { 'README.md': '# x\n' }, {
          version: 1,
          files: {},
          updatedAt: '',
        })
      ).toBe(0)
      expect(
        tombstoneRemovedDocSourceFiles(indexer, { 'README.md': '# x\n' }, {
          version: 1,
          files: { 'README.md': 'hash-a' },
          updatedAt: '',
        })
      ).toBe(0)
    } finally {
      indexer.close()
    }
  })
})
