import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ingestSourceMarkdownFilesAsFacts,
  type ScanFactIngestProgress,
} from '../../src/core/scan-fact-ingest'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('ingestSourceMarkdownFilesAsFacts', () => {
  it('Given markdown with long sentences, then upserts facts with import_doc refs', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-markdown-fact-ingest-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const long =
      'This is the first sentence that is intentionally verbose so it clears the forty character minimum length threshold. ' +
      'Here is another distinct sentence which also exceeds the minimum length for fact ingest pipeline testing purposes.'

    const stats = await ingestSourceMarkdownFilesAsFacts({
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

  it('Given short heading and short prose, then ingests only segments that survive markdown splitting', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-markdown-fact-ingest-short-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const stats = await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'NOTE.md': '## Hi\n\nToo short.' },
    })
    expect(stats.filesScanned).toBe(1)
    expect(stats.segmentsUpserted).toBe(1)
  })

  it('Given multiple markdown files, then emits monotonic per-file progress with current file names', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-markdown-fact-progress-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const snapshots: ScanFactIngestProgress[] = []
    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: {
        'README.md':
          '# Root\n\nThis sentence is intentionally long enough to become a fact during ingest.',
        'docs/guide.md':
          '# Guide\n\nThis second sentence is also intentionally long enough to survive ingest.',
      },
      onProgress(snapshot) {
        snapshots.push(snapshot)
      },
    })

    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.some(snapshot => snapshot.currentFile === 'README.md')).toBe(true)
    expect(snapshots.some(snapshot => snapshot.currentFile === 'docs/guide.md')).toBe(true)
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]?.segmentsUpserted ?? 0).toBeGreaterThanOrEqual(
        snapshots[index - 1]?.segmentsUpserted ?? 0
      )
      expect(snapshots[index]?.filesCompleted ?? 0).toBeGreaterThanOrEqual(
        snapshots[index - 1]?.filesCompleted ?? 0
      )
    }
    const last = snapshots.at(-1)
    expect(last?.filesCompleted).toBe(2)
    expect(last?.filesRemaining).toBe(0)
  })
})
