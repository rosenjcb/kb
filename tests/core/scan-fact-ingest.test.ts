import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    })
    expect(stats.filesScanned).toBe(1)
    expect(stats.segmentsUpserted).toBeGreaterThanOrEqual(2)
    expect(stats.segmentsTombstoned).toBe(0)

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

  it('Given a re-ingest with fewer segments, then tombstones orphaned segment facts', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-markdown-fact-rescan-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const sentenceA =
      'First long sentence about eval harvest pipeline behavior for automated regression testing.'
    const sentenceB =
      'Second long sentence about session management and scoring artifacts for eval runs today.'
    const sentenceC =
      'Third long sentence that will be removed on rescan so its fact must be purged from sqlite.'

    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'EVAL.md': `# Eval\n\n${sentenceA}\n\n${sentenceB}\n\n${sentenceC}` },
    })

    const rescan = await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'EVAL.md': `# Eval\n\n${sentenceA}\n\n${sentenceB}` },
    })
    expect(rescan.segmentsTombstoned).toBeGreaterThanOrEqual(3)
    expect(rescan.segmentsUpserted).toBeGreaterThanOrEqual(2)

    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      const refs = ix.listActiveFactsBySourceRefPrefix('EVAL.md#').map(f => f.source_ref)
      expect(refs).not.toContain('EVAL.md#s2')
      expect(ix.searchFacts('removed on rescan', 5).length).toBe(0)
      expect(ix.searchFacts('session management and scoring artifacts', 5).length).toBeGreaterThan(0)
    } finally {
      ix.close()
    }
  })

  it('Given an emptied markdown file, then purges all prior segment facts', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-markdown-fact-empty-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const sentence =
      'Sentence about npm run eval that should disappear when the markdown file becomes empty.'
    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'EMPTY.md': `# Empty\n\n${sentence}` },
    })

    const cleared = await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'EMPTY.md': '   \n' },
    })
    expect(cleared.segmentsTombstoned).toBeGreaterThan(0)
    expect(cleared.segmentsUpserted).toBe(0)

    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      expect(ix.listActiveFactsBySourceRefPrefix('EMPTY.md#').length).toBe(0)
      expect(ix.searchFacts('npm run eval', 5).length).toBe(0)
    } finally {
      ix.close()
    }
  })
})

describe('OKF resource scoping', () => {
  function seedCodeFact(dbPath: string, sourceRef: string, subject: string, object: string): string {
    const ix = new SqliteKbIndexer({ dbPath })
    const r = ix.upsertFact({
      factText: `${subject} is a Class exported from ${object}`,
      triplet: { subject, predicate: 'exported_from', object },
      sourceKind: 'import_code',
      sourceRef,
    })
    ix.close()
    return r.id
  }

  function conceptsFor(dbPath: string, factId: string): string[] {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db
        .prepare('SELECT concept_id FROM fact_concepts WHERE fact_id = ?')
        .all(factId)
        .map(r => (r as { concept_id: string }).concept_id)
    } finally {
      db.close()
    }
  }

  function docFactId(dbPath: string, refPrefix: string): string {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db
        .prepare('SELECT id FROM facts WHERE source_ref LIKE ? LIMIT 1')
        .get(`${refPrefix}%`) as { id: string } | undefined
      if (!row) throw new Error(`no doc fact for ${refPrefix}`)
      return row.id
    } finally {
      db.close()
    }
  }

  it('seeds the resource file symbols as concepts and links the doc fact to its code facts', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-okf-scope-'))
    tempDirs.push(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const codeId = seedCodeFact(
      dbPath,
      'ast:src/tools/indexer.ts@TreeSitterIndexer',
      'TreeSitterIndexer',
      'src/tools/indexer.ts'
    )

    // Body intentionally shares NO token with the code fact — only the seeded symbol can link them.
    const doc =
      '---\ntype: Module\ntitle: Indexer\nresource: ./src/tools/indexer.ts\n---\n\n' +
      '# Indexer\n\nThe module parses every project file into a graph during the build phase.'
    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'src/tools/INDEXER.md': doc },
      matchAstNodes: true,
    })

    const docId = docFactId(dbPath, 'src/tools/INDEXER.md#')
    expect(conceptsFor(dbPath, docId)).toContain('treesitterindexer')

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const edge = db
        .prepare(
          "SELECT 1 FROM fact_edges WHERE edge_type = 'concept_overlap' AND " +
            '((from_fact_id = ? AND to_fact_id = ?) OR (from_fact_id = ? AND to_fact_id = ?)) LIMIT 1'
        )
        .get(docId, codeId, codeId, docId)
      expect(edge).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('anchors a segment to the in-resource symbol, never a global one', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-okf-anchor-'))
    tempDirs.push(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    seedCodeFact(dbPath, 'ast:src/ui/widget.ts@Widget', 'Widget', 'src/ui/widget.ts')
    seedCodeFact(dbPath, 'ast:src/other/factory.ts@WidgetFactory', 'WidgetFactory', 'src/other/factory.ts')

    const doc =
      '---\ntype: Module\ntitle: Widget\nresource: ./src/ui/widget.ts\n---\n\n' +
      '# Widget\n\nThe widget renders the main control panel for the running application.'
    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'src/ui/WIDGET.md': doc },
      matchAstNodes: true,
    })

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const objs = db
        .prepare("SELECT object FROM facts WHERE source_ref LIKE 'src/ui/WIDGET.md#%'")
        .all()
        .map(r => (r as { object: string }).object)
      expect(objs).toContain('Widget')
      expect(objs).not.toContain('WidgetFactory')
    } finally {
      db.close()
    }
  })

  it('does not seed concepts when matchAstNodes is off (no regression)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-okf-off-'))
    tempDirs.push(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    seedCodeFact(
      dbPath,
      'ast:src/tools/indexer.ts@TreeSitterIndexer',
      'TreeSitterIndexer',
      'src/tools/indexer.ts'
    )

    const doc =
      '---\ntype: Module\nresource: ./src/tools/indexer.ts\n---\n\n' +
      '# Indexer\n\nThe module parses every project file into a graph during the build phase.'
    await ingestSourceMarkdownFilesAsFacts({
      baseDir,
      files: { 'src/tools/INDEXER.md': doc },
    })

    expect(conceptsFor(dbPath, docFactId(dbPath, 'src/tools/INDEXER.md#'))).not.toContain(
      'treesitterindexer'
    )
  })

  it('upsertFact merges extraConcepts into fact_concepts (normalized like text concepts)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-extra-concepts-'))
    tempDirs.push(baseDir)
    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const ix = new SqliteKbIndexer({ dbPath })
    const r = ix.upsertFact({
      factText: 'A doc sentence about the rendering pipeline used in production here today.',
      sourceKind: 'import_doc',
      sourceRef: 'X.md#s0',
      extraConcepts: ['TreeSitterIndexer'],
    })
    ix.close()
    expect(conceptsFor(dbPath, r.id)).toContain('treesitterindexer')
  })
})
