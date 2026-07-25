#!/usr/bin/env node
// Fast, targeted regression check for the embedAllFacts fix (issue #191).
//
// Complements large-repo-memory-bench.sh: that script proves the fix holds up
// on a real repo end-to-end, but a real cold `kb-server refresh` can take a
// long time to reach the embedding phase (large repos spend most of their
// time in code-index/document-facts first). This script skips straight to
// the thing that actually changed — SqliteKbIndexer.embedAllFacts's SELECT —
// by seeding a throwaway SQLite index with many synthetic facts via raw SQL
// (bypassing `upsertFact`'s per-call graph-rebuild pass, a real but unrelated
// cost documented in INIT.md's "Tried and reverted" section — it makes even
// modest synthetic seeding minutes-slow and has nothing to do with what this
// checks) and then calling embedAllFacts with a fake, instant embedder (no ML
// inference — isolates the SQL-pagination behavior from real embedding
// latency).
//
// Prints RSS at intervals during both seeding and embedding. If embedAllFacts
// ever regresses back to loading the whole stale-fact set in one array, RSS
// during the embedding phase will climb roughly linearly with FACT_COUNT
// instead of staying flat.
//
// Usage:
//   node scripts/bench/embed-all-facts-fetch-bench.mjs [factCount]
//   (factCount default: 50000 — enough for ~50 pages at the default
//   KB_EMBED_FETCH_PAGE_SIZE=1000, small enough to seed in well under a minute)
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteKbIndexer } from '../../packages/kb-core/src/tools/sqlite-kb-index.ts'

const FACT_COUNT = Number(process.argv[2] ?? 50000)
const FACT_TEXT = 'x'.repeat(300) // representative fact_text size

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kb-embed-bench-'))
const dbPath = path.join(tmp, 'test.sqlite')

function rssMiB() {
  return (process.memoryUsage().rss / 1048576).toFixed(1)
}

// Run migrations for real (via SqliteKbIndexer), then close and seed with raw
// SQL — upsertFact's per-call graph-rebuild pass is real but unrelated to
// what embedAllFacts does, and makes normal-API seeding minutes-slow at this
// scale for no benefit to this specific check.
new SqliteKbIndexer({ dbPath }).close()

console.log(`seeding ${FACT_COUNT} synthetic facts into ${dbPath} via raw SQL ...`)
const t0 = Date.now()
const seedDb = new DatabaseSync(dbPath)
seedDb.exec('BEGIN')
const insert = seedDb.prepare(
  `INSERT INTO facts (id, fact_text, normalized_text, source_kind, source_ref, confidence, created_at, updated_at, git_repo)
   VALUES (?, ?, ?, 'import_code', ?, 0.8, ?, ?, 'synthetic')`
)
const now = new Date().toISOString()
for (let i = 0; i < FACT_COUNT; i++) {
  insert.run(`synthetic-fact-${i}`, `${FACT_TEXT} fact-${i}`, `synthetic-fact-${i}`, `ast:synthetic/file-${i % 5000}.rb@${i}`, now, now)
  if (i % 10000 === 0) console.log(`  seeded ${i}/${FACT_COUNT}, rss=${rssMiB()}MiB`)
}
seedDb.exec('COMMIT')
seedDb.close()
console.log(`seed done in ${((Date.now() - t0) / 1000).toFixed(1)}s, rss=${rssMiB()}MiB`)

// Fake embedder: constant vector, no ML inference. Isolates the SQL-read
// pagination fix from real embedding compute cost.
const fakeEmbedder = {
  modelId: 'fake-test-embedder',
  dimensions: 8,
  async embed(texts) {
    return texts.map(() => [1, 2, 3, 4, 5, 6, 7, 8])
  },
}

const indexer = new SqliteKbIndexer({ dbPath, embedder: fakeEmbedder })
let peakRss = process.memoryUsage().rss

console.log('running embedAllFacts ...')
const t1 = Date.now()
const embedded = await indexer.embedAllFacts((done, total) => {
  const rss = process.memoryUsage().rss
  if (rss > peakRss) peakRss = rss
  if (done % 10000 < 1000) console.log(`  embedding ${done}/${total}, rss=${rssMiB()}MiB`)
})
indexer.close()

console.log(`embedded ${embedded} facts in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
console.log(`peak RSS during embedAllFacts: ${(peakRss / 1048576).toFixed(1)}MiB`)
console.log(
  peakRss / 1048576 < 400
    ? '✅ peak RSS stayed well bounded regardless of fact count — pagination is working.'
    : '⚠ peak RSS higher than expected — investigate before trusting this as a pass.'
)

rmSync(tmp, { recursive: true, force: true })
