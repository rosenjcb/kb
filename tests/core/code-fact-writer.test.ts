import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeSymbolKey,
  deleteRemovedCodeFiles,
  deleteStaleCodeSymbols,
  upsertCodeSymbol,
} from '@kb/core/tools/code-fact-writer.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function newIndexer(): Promise<SqliteKbIndexer> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-symbol-'))
  tempDirs.push(baseDir)
  return new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
}

function keysForRepo(indexer: SqliteKbIndexer, gitRepo: string): Set<string> {
  return new Set(
    indexer.listCodeSymbolKeysByRepo(gitRepo).map(r => codeSymbolKey(r.rel_path, r.name))
  )
}

describe('deleteRemovedCodeFiles', () => {
  it('[TC-172] deletes only the removed file symbols, scoped to its repo', async () => {
    const indexer = await newIndexer()
    try {
      upsertCodeSymbol(indexer, 'src/a.ts', 'foo', 'function', undefined, 'repo-a')
      upsertCodeSymbol(indexer, 'src/a.ts', 'BAR', 'constant', undefined, 'repo-a')
      upsertCodeSymbol(indexer, 'src/keep.ts', 'keep', 'function', undefined, 'repo-a')
      upsertCodeSymbol(indexer, 'src/a_b.ts', 'sibling', 'function', undefined, 'repo-a')
      upsertCodeSymbol(indexer, 'src/a.ts', 'foo', 'function', undefined, 'repo-b')

      const removed = deleteRemovedCodeFiles(indexer, ['src/a.ts'], 'repo-a')
      expect(removed).toBe(2)
      expect(keysForRepo(indexer, 'repo-a')).toEqual(
        new Set([codeSymbolKey('src/keep.ts', 'keep'), codeSymbolKey('src/a_b.ts', 'sibling')])
      )
      expect(keysForRepo(indexer, 'repo-b')).toEqual(new Set([codeSymbolKey('src/a.ts', 'foo')]))
    } finally {
      indexer.close()
    }
  })

  it('[TC-173] is a no-op when nothing was removed', async () => {
    const indexer = await newIndexer()
    try {
      upsertCodeSymbol(indexer, 'src/a.ts', 'foo', 'function', undefined, 'repo-a')
      expect(deleteRemovedCodeFiles(indexer, [], 'repo-a')).toBe(0)
      expect(keysForRepo(indexer, 'repo-a')).toEqual(new Set([codeSymbolKey('src/a.ts', 'foo')]))
    } finally {
      indexer.close()
    }
  })

  it('[TC-174] contrast: blanket deleteStaleCodeSymbols would purge unchanged files on a partial rescan', async () => {
    const indexer = await newIndexer()
    try {
      upsertCodeSymbol(indexer, 'src/changed.ts', 'a', 'function', undefined, 'repo-a')
      upsertCodeSymbol(indexer, 'src/unchanged.ts', 'b', 'function', undefined, 'repo-a')
      const partialKeys = new Set([codeSymbolKey('src/changed.ts', 'a')])
      const purged = deleteStaleCodeSymbols(indexer, partialKeys, 'repo-a')
      expect(purged).toBe(1)
      expect(keysForRepo(indexer, 'repo-a')).toEqual(new Set([codeSymbolKey('src/changed.ts', 'a')]))
    } finally {
      indexer.close()
    }
  })
})
