import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let indexer: SqliteKbIndexer

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-reconcile-test-'))
  indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
})

afterEach(async () => {
  indexer.close()
  await rm(baseDir, { recursive: true, force: true })
})

/** Seed two repos that reference each other: repoA depends on repoB's package + imports a symbol it exports. */
function seedTwoRepos() {
  indexer.upsertFact({
    factText: 'Repository a depends on package @org/b-pkg.',
    triplet: { subject: 'a', predicate: 'depends_on', object: '@org/b-pkg' },
    sourceKind: 'import_doc',
    sourceRef: 'a/integration:dep:@org/b-pkg',
    gitRepo: 'a',
  })
  indexer.upsertFact({
    factText: 'Package @org/b-pkg is provided by repository b.',
    triplet: { subject: '@org/b-pkg', predicate: 'package_name_of', object: 'b' },
    sourceKind: 'import_doc',
    sourceRef: 'b/integration:package',
    gitRepo: 'b',
  })
  indexer.upsertFact({
    factText: 'a/src/main.ts imports Widget',
    triplet: { subject: 'a/src/main.ts', predicate: 'imports', object: 'Widget' },
    sourceKind: 'import_code',
    sourceRef: 'ast:import:a-widget',
    gitRepo: 'a',
  })
  indexer.upsertFact({
    factText: 'Widget is a class exported from src/widget.ts',
    triplet: { subject: 'Widget', predicate: 'exported_from', object: 'src/widget.ts' },
    sourceKind: 'import_code',
    sourceRef: 'ast:src/widget.ts@Widget',
    gitRepo: 'b',
  })
}

describe('reconcileCrossRepoEdges', () => {
  it('[TC-13] bridges repos via package dependency and cross-repo symbol imports', () => {
    seedTwoRepos()
    const created = indexer.reconcileCrossRepoEdges()
    expect(created).toBeGreaterThan(0)

    const links = indexer.listCrossRepoLinks()
    // a → b is reachable (both depends_on_repo and cross_repo_symbol collapse to a→b)
    expect(links.some(l => l.fromRepo === 'a' && l.toRepo === 'b')).toBe(true)
  })

  it('[TC-14] lets graph traversal cross repo boundaries', () => {
    seedTwoRepos()
    indexer.reconcileCrossRepoEdges()

    const depFact = indexer.listFactsForQuery(9999).find(f => f.predicate === 'depends_on')
    expect(depFact).toBeDefined()
    const neighbors = indexer.getFactNeighbors(depFact ? [depFact.id] : [], new Set())
    expect(neighbors.some(n => n.git_repo === 'b')).toBe(true)
  })

  it('[TC-15] is idempotent on re-run', () => {
    seedTwoRepos()
    indexer.reconcileCrossRepoEdges()
    expect(indexer.reconcileCrossRepoEdges()).toBe(0)
  })

  it('[TC-16] does not link a repo to itself', () => {
    seedTwoRepos()
    indexer.reconcileCrossRepoEdges()
    expect(indexer.listCrossRepoLinks().every(l => l.fromRepo !== l.toRepo)).toBe(true)
  })

  it('[TC-17] removing a repo purges its facts and drops dangling cross-repo links', () => {
    seedTwoRepos()
    indexer.reconcileCrossRepoEdges()

    const removed = indexer.deleteFactsByRepo('b')
    expect(removed).toBeGreaterThan(0)
    indexer.reconcileCrossRepoEdges()

    expect(indexer.listCrossRepoLinks()).toHaveLength(0)
    expect(indexer.listFactsForQuery(9999).some(f => f.git_repo === 'b')).toBe(false)
  })
})
