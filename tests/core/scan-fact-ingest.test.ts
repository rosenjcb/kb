import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestSourceMarkdownFilesAsFacts } from '../../src/core/scan-fact-ingest'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('ingestSourceMarkdownFilesAsFacts', () => {
  it('Given markdown with long sentences, then upserts facts with import_doc refs', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-scan-ingest-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const long =
      'This is the first sentence that is intentionally verbose so it clears the forty character minimum length threshold. ' +
      'Here is another distinct sentence which also exceeds the minimum length for fact ingest pipeline testing purposes.'

    const stats = ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'README.md': `# Title\n\n${long}` },
      maxTotal: 100,
    })
    expect(stats.filesScanned).toBe(1)
    expect(stats.segmentsUpserted).toBeGreaterThanOrEqual(2)

    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      const hits = ix.searchFacts('verbose forty character', 10)
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits.some(h => h.source_ref?.startsWith('README.md#s'))).toBe(true)
    } finally {
      ix.close()
    }
  })

  it('Given short-only segments, then upserts zero and counts skipped', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-scan-ingest-short-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const stats = ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'NOTE.md': '## Hi\n\nToo short.' },
      minSegmentLength: 40,
    })
    expect(stats.segmentsUpserted).toBe(0)
    expect(stats.segmentsSkippedShort).toBeGreaterThan(0)
  })
})
