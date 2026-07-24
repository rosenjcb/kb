import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  tombstoneRemovedCodeFiles,
  tombstoneStaleCodeFacts,
} from '@kb/core/tools/code-fact-writer.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function newIndexer(): Promise<SqliteKbIndexer> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-fact-'))
  tempDirs.push(baseDir)
  return new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
}

function addCodeFact(indexer: SqliteKbIndexer, sourceRef: string, gitRepo: string): void {
  // Fact dedup is keyed on normalized fact text, so a colliding repo-relative source_ref
  // across two repos must carry distinct text (mirrors real content differing per repo).
  indexer.upsertFact({
    factText: `symbol fact for ${sourceRef} in ${gitRepo} that is long enough to satisfy validation.`,
    sourceKind: 'import_code',
    sourceRef,
    confidence: 0.65,
    gitRepo,
  })
}

function activeAstRefsForRepo(indexer: SqliteKbIndexer, gitRepo: string): Set<string> {
  return new Set(
    indexer
      .listActiveFactsBySourceRefPrefix('ast:')
      .filter(f => f.git_repo === gitRepo)
      .map(f => f.source_ref)
      .filter((r): r is string => typeof r === 'string')
  )
}

describe('tombstoneRemovedCodeFiles', () => {
  it('[TC-629] tombstones only the removed file, scoped to its repo, leaving siblings and other repos intact', async () => {
    const indexer = await newIndexer()
    try {
      // repo-a: two files, plus a `_`-bearing sibling that a naive LIKE-prefix would falsely match.
      addCodeFact(indexer, 'ast:src/a.ts@foo', 'repo-a')
      addCodeFact(indexer, 'ast:const:src/a.ts@BAR', 'repo-a')
      addCodeFact(indexer, 'ast:src/keep.ts@keep', 'repo-a')
      addCodeFact(indexer, 'ast:src/a_b.ts@sibling', 'repo-a')
      // repo-a import edge — path hashed away, not file-mappable.
      addCodeFact(indexer, 'ast:import:deadbeef', 'repo-a')
      // repo-b: colliding repo-relative path, different repo — must survive.
      addCodeFact(indexer, 'ast:src/a.ts@foo', 'repo-b')

      const removed = tombstoneRemovedCodeFiles(indexer, ['src/a.ts'], 'repo-a')
      expect(removed).toBe(2)

      // repo-a: src/a.ts facts gone; sibling, keep, and the (unmappable) import edge remain.
      expect(activeAstRefsForRepo(indexer, 'repo-a')).toEqual(
        new Set(['ast:src/keep.ts@keep', 'ast:src/a_b.ts@sibling', 'ast:import:deadbeef'])
      )
      // repo-b untouched.
      expect(activeAstRefsForRepo(indexer, 'repo-b')).toEqual(new Set(['ast:src/a.ts@foo']))
    } finally {
      indexer.close()
    }
  })

  it('[TC-630] is a no-op when nothing was removed', async () => {
    const indexer = await newIndexer()
    try {
      addCodeFact(indexer, 'ast:src/a.ts@foo', 'repo-a')
      expect(tombstoneRemovedCodeFiles(indexer, [], 'repo-a')).toBe(0)
      expect(activeAstRefsForRepo(indexer, 'repo-a')).toEqual(new Set(['ast:src/a.ts@foo']))
    } finally {
      indexer.close()
    }
  })

  it('[TC-631] contrast: blanket tombstoneStaleCodeFacts would purge unchanged files on a partial rescan', async () => {
    const indexer = await newIndexer()
    try {
      addCodeFact(indexer, 'ast:src/changed.ts@a', 'repo-a')
      addCodeFact(indexer, 'ast:src/unchanged.ts@b', 'repo-a')

      // Simulate a partial rescan where only `src/changed.ts` was re-indexed, so the
      // current source-ref set omits the unchanged file. This demonstrates WHY the
      // partial path must use tombstoneRemovedCodeFiles instead.
      const partialRefs = new Set(['ast:src/changed.ts@a'])
      const purged = tombstoneStaleCodeFacts(indexer, partialRefs, 'repo-a')
      expect(purged).toBe(1) // unchanged.ts wrongly purged — the data-loss the guard prevents
      expect(activeAstRefsForRepo(indexer, 'repo-a')).toEqual(new Set(['ast:src/changed.ts@a']))
    } finally {
      indexer.close()
    }
  })
})
