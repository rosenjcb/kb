import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPondQueries,
  FactsQueryResearchOrchestrator,
  isUnlimitedLimit,
} from '../../src/tools/facts-query-research-orchestrator'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-facts-loop-'))
  tempDirs.push(dir)
  return dir
}

describe('buildPondQueries', () => {
  it('Given multi-token query, then builds primary, pair, and single-token ponds', () => {
    const ponds = buildPondQueries(
      'languages supported by kb init and scan tool',
      ['languages', 'supported', 'init', 'scan', 'tool'],
      12
    )
    expect(ponds[0]).toBe('languages supported by kb init and scan tool')
    expect(ponds).toContain('languages supported')
    expect(ponds).toContain('init scan')
    expect(ponds).toContain('languages scan')
  })

  it('Given maxPonds -1, then returns every generated pond query', () => {
    const ponds = buildPondQueries(
      'rust code graph',
      ['rust', 'code', 'graph'],
      -1
    )
    expect(ponds.length).toBeGreaterThan(6)
    expect(ponds).toContain('rust')
    expect(isUnlimitedLimit(-1)).toBe(true)
  })
})

describe('assessSufficiency threshold', () => {
  it('Given fewer than 20 relevant facts, then loop does not stop early on sufficiency', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    // Insert exactly 15 highly-relevant facts (old threshold was 10@0.40, new is 20@0.50)
    for (let i = 0; i < 15; i++) {
      indexer.upsertFact({
        factText: `query expansion mechanism step ${i} calls expandQueryWithGraph in orchestrator`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion mechanism orchestrator',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    // Should NOT stop with answerable_plateau when only 15 facts found
    expect(response.retrieval.detail).not.toContain('stop:answerable_plateau')
    indexer.close()
  })

  it('Given 20+ relevant high-scoring facts, then loop stops as answerable', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    // Insert 25 highly-relevant facts
    for (let i = 0; i < 25; i++) {
      indexer.upsertFact({
        factText: `query expansion mechanism step ${i} calls expandQueryWithGraph in orchestrator pipeline`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion mechanism orchestrator',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.results.length).toBeGreaterThanOrEqual(20)
    indexer.close()
  })
})

describe('FactsQueryResearchOrchestrator ponds', () => {
  it('Given reserved anchor and source slots overlap, then buildResponse dedupes fact ids', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const shared = indexer.upsertFact({
      factText: 'Supported languages include Rust via tree-sitter AST code-graph indexing',
      sourceKind: 'import_doc',
      sourceRef: 'init-md',
      confidence: 0.95,
    })
    indexer.upsertFact({
      factText: 'parseScanCommand is exported from src/cli/init-cli.ts',
      triplet: {
        subject: 'parseScanCommand',
        predicate: 'exported_from',
        object: 'src/cli/init-cli.ts',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:init-cli',
      confidence: 0.95,
    })

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'supported languages rust code-graph',
      limit: 5,
      includeContent: true,
      surface: 'query',
    })

    const ids = response.results.map(result => result.metadata.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(shared.id)
    indexer.close()
  })

  it('Given generated _site code facts, then they are excluded from surfaced results', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const languageList = indexer.upsertFact({
      factText:
        'Code-graph indexing supported languages include Go, TS/TSX, JS/JSX, Python, Rust, Ruby, Java, C/C++, C#, CSS, Bash, PHP via EXT_MAP.',
      sourceKind: 'import_doc',
      sourceRef: 'src/core/INIT.md#languages',
      confidence: 0.95,
    })
    const siteNoise = indexer.upsertFact({
      factText:
        'code-graph indexing supported languages vp-nav-star attribute_value exported from docs/_site/evaluation.html',
      triplet: {
        subject: 'vp-nav-star',
        predicate: 'attribute_value',
        object: 'docs/_site/evaluation.html',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:docs/_site/evaluation.html',
      confidence: 0.99,
    })
    expect(siteNoise.id).toMatch(/^fact-/)

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'code-graph indexing supported languages',
      limit: 5,
      includeContent: true,
      surface: 'query',
    })

    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results.every(result => !/docs\/_site\//.test(result.content ?? ''))).toBe(true)
    expect(response.results.map(result => result.metadata.id)).toContain(languageList.id)
    indexer.close()
  })

  it('Given disjoint doc and code facts, pond search keeps primary lexical anchors in results', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const languageDoc = indexer.upsertFact({
      factText: 'Supported languages are indexed deterministically by the AST pipeline and promoted into facts.',
      sourceKind: 'import_doc',
      sourceRef: 'init-md',
      confidence: 0.9,
    })
    const codeFact = indexer.upsertFact({
      factText: 'parseScanCommand is a Function exported from src/cli/init-cli.ts',
      triplet: {
        subject: 'parseScanCommand',
        predicate: 'exported_from',
        object: 'src/cli/init-cli.ts',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:init-cli',
      confidence: 0.95,
    })
    indexer.upsertFact({
      factText: 'src/cli/init-cli.ts imports src/tools/code-graph-indexer.ts',
      triplet: {
        subject: 'src/cli/init-cli.ts',
        predicate: 'imports',
        object: 'src/tools/code-graph-indexer.ts',
      },
      sourceKind: 'import_code',
      sourceRef: 'code:init-cli@import',
      confidence: 0.95,
    })
    indexer.relinkCodeImportEdges()

    const noise: string[] = []
    for (let i = 0; i < 12; i++) {
      const row = indexer.upsertFact({
        factText: `init scan helper symbol ${i} exported from src/cli/init-cli.ts`,
        triplet: {
          subject: `InitHelper${i}`,
          predicate: 'exported_from',
          object: 'src/cli/init-cli.ts',
        },
        sourceKind: 'import_code',
        sourceRef: `code:noise-${i}`,
        confidence: 0.95,
      })
      noise.push(row.id)
    }

    expect(indexer.getFactNeighbors([codeFact.id], new Set(), 20).length).toBeGreaterThan(0)

    const orchestrator = new FactsQueryResearchOrchestrator(indexer)
    const response = orchestrator.run({
      query: 'languages supported by kb init and scan tool',
      limit: 6,
      includeContent: true,
      surface: 'query',
    })

    const ids = response.results.map(result => result.metadata.id)
    expect(ids).toContain(languageDoc.id)
    expect(response.retrieval.detail).toContain('ponds:')
    indexer.close()
  })
})

describe('FactsQueryResearchOrchestrator — hard cap', () => {
  it('Given KB_MAX_FACTS_FOR_LLM=5, then results are capped to at most 5 facts', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    for (let i = 0; i < 30; i++) {
      indexer.upsertFact({
        factText: `raylib provides rendering module step ${i} with opengl backend`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.9,
      })
    }

    const prev = process.env.KB_MAX_FACTS_FOR_LLM
    process.env.KB_MAX_FACTS_FOR_LLM = '5'
    try {
      const response = new FactsQueryResearchOrchestrator(indexer).run({
        query: 'raylib rendering opengl',
        limit: 500,
        includeContent: true,
        surface: 'query',
      })
      expect(response.results.length).toBeLessThanOrEqual(5)
      expect(response.retrieval.detail).toContain('facts:')
    } finally {
      if (prev === undefined) delete process.env.KB_MAX_FACTS_FOR_LLM
      else process.env.KB_MAX_FACTS_FOR_LLM = prev
    }
    indexer.close()
  })

  it('Given KB_MAX_FACTS_FOR_LLM=-1, then results are not capped', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    for (let i = 0; i < 30; i++) {
      indexer.upsertFact({
        factText: `raylib provides rendering module step ${i} with opengl backend`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.9,
      })
    }

    const prev = process.env.KB_MAX_FACTS_FOR_LLM
    process.env.KB_MAX_FACTS_FOR_LLM = '-1'
    try {
      const response = new FactsQueryResearchOrchestrator(indexer).run({
        query: 'raylib rendering opengl',
        limit: 500,
        includeContent: true,
        surface: 'query',
      })
      expect(response.results.length).toBeGreaterThan(5)
    } finally {
      if (prev === undefined) delete process.env.KB_MAX_FACTS_FOR_LLM
      else process.env.KB_MAX_FACTS_FOR_LLM = prev
    }
    indexer.close()
  })

  it('Given default cap, then retrieval detail includes facts count', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.upsertFact({
      factText: 'raylib is a simple game development library',
      sourceKind: 'import_doc',
      sourceRef: 'doc-1',
      confidence: 0.9,
    })

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'raylib',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })
    expect(response.retrieval.detail).toMatch(/facts:\d+/)
    indexer.close()
  })
})

describe('FactsQueryResearchOrchestrator — relevant-facts plateau', () => {
  it('Given plateau of low-quality facts with no new relevant facts, then loop stops within 3 extra iterations', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    // Insert a few on-topic facts plus many off-topic ones
    for (let i = 0; i < 3; i++) {
      indexer.upsertFact({
        factText: `query expansion calls expandQueryWithGraph step ${i}`,
        sourceKind: 'import_doc',
        sourceRef: `on-topic-${i}`,
        confidence: 0.9,
      })
    }
    for (let i = 0; i < 20; i++) {
      indexer.upsertFact({
        factText: `unrelated noise fact about fruit growing season ${i}`,
        sourceKind: 'import_doc',
        sourceRef: `noise-${i}`,
        confidence: 0.9,
      })
    }

    const response = new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion expandQueryWithGraph',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    // Should stop within the configured max iterations (not running all 24)
    const passesMatch = response.retrieval.detail?.match(/passes:(\d+)/)
    const passes = passesMatch ? parseInt(passesMatch[1], 10) : 999
    expect(passes).toBeLessThan(24)
    indexer.close()
  })
})
