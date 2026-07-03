import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FactsDocumentReader } from '../../src/tools/facts-document-reader'
import { FactsQueryResearchOrchestrator } from '../../src/tools/facts-query-research-orchestrator'
import type { CurationRecord } from '../../src/tools/fact-curator'
import {
  type QueryTraceDump,
  type QueryTraceLane,
  buildCurationTrace,
  isQueryTraceEnabled,
  newTraceId,
  tracedFactFromRow,
  writeQueryTrace,
} from '../../src/tools/query-trace'
import { type FactRow, SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

const prevKbHome = process.env.KB_HOME

afterEach(async () => {
  process.env.KB_QUERY_TRACE = undefined
  process.env.KB_HOME = prevKbHome
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-query-trace-'))
  tempDirs.push(dir)
  return dir
}

function fakeRow(overrides: Partial<FactRow>): FactRow {
  return {
    id: 'f1',
    fact_text: 'a fact',
    normalized_text: 'a fact',
    source_kind: 'import_doc',
    source_ref: null,
    confidence: 0.9,
    supersedes_fact_id: null,
    tombstoned_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    subject: '',
    predicate: '',
    object: '',
    source_text: null,
    git_repo: null,
    ...overrides,
  }
}

describe('isQueryTraceEnabled', () => {
  it('[TC-93] Given KB_QUERY_TRACE unset or false, then tracing is off (default)', () => {
    process.env.KB_QUERY_TRACE = undefined
    expect(isQueryTraceEnabled()).toBe(false)
    process.env.KB_QUERY_TRACE = 'false'
    expect(isQueryTraceEnabled()).toBe(false)
    process.env.KB_QUERY_TRACE = '1'
    expect(isQueryTraceEnabled()).toBe(false)
  })

  it('[TC-94] Given KB_QUERY_TRACE=true (any case), then tracing is on', () => {
    process.env.KB_QUERY_TRACE = 'true'
    expect(isQueryTraceEnabled()).toBe(true)
    process.env.KB_QUERY_TRACE = '  TRUE  '
    expect(isQueryTraceEnabled()).toBe(true)
  })
})

describe('tracedFactFromRow', () => {
  it('[TC-95] Given a code fact, then dumps source_text (the actual code) with rounded score', () => {
    const fact = tracedFactFromRow(
      fakeRow({
        id: 'code-1',
        source_kind: 'import_code',
        fact_text: 'kbIgnore filters paths',
        source_text: 'export function kbIgnore(p: string) { return true }',
        git_repo: 'rosenjcb/kb',
      }),
      0.123456
    )
    expect(fact.content).toContain('export function kbIgnore')
    expect(fact.sourceKind).toBe('import_code')
    expect(fact.repo).toBe('rosenjcb/kb')
    expect(fact.score).toBe(0.1235)
  })

  it('[TC-96] Given a doc fact with no repo, then dumps fact_text and omits repo', () => {
    const fact = tracedFactFromRow(fakeRow({ id: 'doc-1', fact_text: 'ignore rules doc' }), 0.5)
    expect(fact.content).toBe('ignore rules doc')
    expect(fact.repo).toBeUndefined()
  })
})

describe('buildCurationTrace', () => {
  it('[TC-97] Given a curator record, then recovers dropped fact content by id from the lanes', () => {
    const lane: QueryTraceLane = {
      query: 'kb ignore',
      knobs: { maxIterations: 24, maxGraphHops: 20, maxPonds: 6, perIterationLimit: 50 },
      iterations: 3,
      graphHops: 2,
      pondCount: 2,
      stopReason: 'llm_judge_answerable',
      passTrace: ['i1:merged=4'],
      checkpoints: [],
      discovered: [
        {
          id: 'keep-1',
          title: 'kbIgnore entry',
          score: 0.8,
          sourceKind: 'import_code',
          content: 'function kbIgnore() {}',
        },
        {
          id: 'drop-1',
          title: 'unrelated fact',
          score: 0.21,
          sourceKind: 'import_doc',
          content: 'something off topic',
        },
      ],
      returned: ['keep-1', 'drop-1'],
      droppedBelowFloor: [],
    }
    const record: CurationRecord = {
      evaluated: 2,
      autoKept: 1,
      dropped: [{ id: 'drop-1', reason: 'off-topic' }],
      requeried: ['ignore globs'],
      added: 0,
      rounds: 1,
      sufficient: true,
      fellBack: false,
    }

    const curation = buildCurationTrace(record, [lane], 1)
    expect(curation.kept).toBe(1)
    expect(curation.dropped).toHaveLength(1)
    expect(curation.dropped[0]).toMatchObject({
      id: 'drop-1',
      reason: 'off-topic',
      content: 'something off topic',
      title: 'unrelated fact',
    })
    expect(curation.requeried).toEqual(['ignore globs'])
  })
})

describe('writeQueryTrace', () => {
  it('[TC-98] Given a dump, then writes <traceId>.json that round-trips', async () => {
    const dir = await createTempDir()
    const dump: QueryTraceDump = {
      traceId: newTraceId(),
      createdAt: new Date().toISOString(),
      query: 'kb ignore',
      lanes: [],
    }
    const file = await writeQueryTrace(dir, dump)
    expect(file).toBe(path.join(dir, `${dump.traceId}.json`))
    const parsed = JSON.parse(await readFile(file, 'utf-8'))
    expect(parsed.query).toBe('kb ignore')
  })
})

describe('orchestrator trace lane', () => {
  it('[TC-99] Given KB_QUERY_TRACE=true, then run() attaches a lane dumping every discovered fact', async () => {
    const dir = await createTempDir()
    const indexer = new SqliteKbIndexer({ dbPath: path.join(dir, 'kb-index.sqlite') })
    for (let i = 0; i < 6; i++) {
      indexer.upsertFact({
        factText: `kb ignore rule ${i} filters directories and paths during scan`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }

    process.env.KB_QUERY_TRACE = 'true'
    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'kb ignore directories paths',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.trace).toBeDefined()
    const lane = response.trace as QueryTraceLane
    expect(lane.knobs.maxIterations).toBeGreaterThan(0)
    expect(lane.discovered.length).toBeGreaterThan(0)
    expect(lane.discovered.every(f => typeof f.content === 'string' && f.content.length > 0)).toBe(
      true
    )
    expect(lane.returned.length).toBeGreaterThan(0)
    indexer.close()
  })

  it('[TC-100] Given --trace on a deep query, then the reader writes a dump under KB_HOME/traces', async () => {
    const dir = await createTempDir()
    process.env.KB_HOME = dir
    const dbPath = path.join(dir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    for (let i = 0; i < 6; i++) {
      indexer.upsertFact({
        factText: `kb ignore rule ${i} filters directories and paths during scan`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }
    indexer.close()

    process.env.KB_QUERY_TRACE = 'true'
    const reader = new FactsDocumentReader(dbPath)
    await reader.queryDocuments({
      query: 'kb ignore directories paths',
      discoveryDepth: 'deep',
      includeContent: true,
      surface: 'query',
    })

    const written = await readdir(path.join(dir, 'traces'))
    expect(written.some(name => name.startsWith('qtrace-') && name.endsWith('.json'))).toBe(true)
  })

  it('[TC-101] Given tracing off, then run() attaches no lane', async () => {
    const dir = await createTempDir()
    const indexer = new SqliteKbIndexer({ dbPath: path.join(dir, 'kb-index.sqlite') })
    indexer.upsertFact({
      factText: 'kb ignore rule filters paths',
      sourceKind: 'import_doc',
      sourceRef: 'doc-0',
      confidence: 0.95,
    })

    process.env.KB_QUERY_TRACE = 'false'
    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'kb ignore paths',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.trace).toBeUndefined()
    indexer.close()
  })
})
