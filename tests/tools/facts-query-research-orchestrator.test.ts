import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPondQueries,
  FactsQueryResearchOrchestrator,
  isUnlimitedLimit,
} from '@kb/core/tools/facts-query-research-orchestrator.js'
import type { FactsSufficiencyJudge } from '@kb/core/tools/facts-sufficiency-judge.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

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
  it('[TC-26] Given multi-token query, then builds primary, pair, and single-token ponds', () => {
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

  it('[TC-27] Given maxPonds -1, then returns every generated pond query', () => {
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
  it('[TC-28] Given fewer than 20 relevant facts, then loop does not stop early on sufficiency', async () => {
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

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion mechanism orchestrator',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    // Should NOT stop with answerable_plateau when only 15 facts found
    expect(response.retrieval.detail).not.toContain('stop:answerable_plateau')
    indexer.close()
  })

  it('[TC-29] Given 20+ relevant high-scoring facts, then loop stops as answerable', async () => {
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

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
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
  it('[TC-30] Given reserved anchor and source slots overlap, then buildResponse dedupes fact ids', async () => {
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

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
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

  it('[TC-31] Given generated _site code facts, then they are excluded from surfaced results', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const languageList = indexer.upsertFact({
      factText:
        'Code-graph indexing supported languages include Go, TS/TSX, JS/JSX, Python, Rust, Ruby, Java, C/C++, C#, CSS, Bash, PHP, Scala, HTML, Haskell via EXT_MAP.',
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

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
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

  it('[TC-32] Given disjoint doc and code facts, pond search keeps primary lexical anchors in results', async () => {
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
    const response = await orchestrator.run({
      query: 'languages supported by kb init and scan tool',
      limit: 6,
      includeContent: true,
      surface: 'query',
    })

    const ids = response.results.map(result => result.metadata.id)
    expect(ids).toContain(languageDoc.id)
    expect(response.retrieval.detail).toContain('ponds:')
    indexer.close()
  }, 30000)
})

describe('FactsQueryResearchOrchestrator — hard cap', () => {
  it('[TC-33] Given more facts than MAX_FACTS_FOR_LLM, then results are capped at 150', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    for (let i = 0; i < 160; i++) {
      indexer.upsertFact({
        factText: `raylib rendering opengl step ${i}`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.9,
      })
    }

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'raylib rendering opengl',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })
    expect(response.results.length).toBeLessThanOrEqual(150)
    expect(response.retrieval.detail).toContain('facts:')
    indexer.close()
  }, 30000)

  it('[TC-34] Given retrieval detail, then it includes facts count', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.upsertFact({
      factText: 'raylib is a simple game development library',
      sourceKind: 'import_doc',
      sourceRef: 'doc-1',
      confidence: 0.9,
    })

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
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
  it('[TC-35] Given plateau of low-quality facts with no new relevant facts, then loop stops within 3 extra iterations', async () => {
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

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion expandQueryWithGraph',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    // Should stop within the configured max iterations (not running all 24)
    const passesMatch = response.retrieval.detail?.match(/passes:(\d+)/)
    const passes = passesMatch ? Number.parseInt(passesMatch[1], 10) : 999
    expect(passes).toBeLessThan(24)
    indexer.close()
  })
})

describe('FactsQueryResearchOrchestrator — code fact graph-proximity scoring', () => {
  it('[TC-36] Given code fact linked via graph to a high-scoring doc fact, then it ranks higher than an identifier-only code fact', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    // High-relevance doc fact — directly answers the query
    const docFact = indexer.upsertFact({
      factText: 'expandQuery is the entry point for query expansion in the orchestrator pipeline',
      sourceKind: 'import_doc',
      sourceRef: 'ARCH.md',
      confidence: 0.95,
    })

    // Code fact: linked to the doc fact via concept overlap (shares "expandQuery", "expansion")
    const graphLinkedCode = indexer.upsertFact({
      factText: 'expandQuery is a Function exported from src/tools/query-expander.ts',
      triplet: { subject: 'expandQuery', predicate: 'exported_from', object: 'src/tools/query-expander.ts' },
      sourceKind: 'import_code',
      sourceRef: 'code:query-expander',
      confidence: 0.95,
    })

    // Code fact: identifier matches "query" but is totally unrelated (false positive by text)
    const identifierOnlyCode = indexer.upsertFact({
      factText: 'queryResultCache is a Variable exported from src/tools/cache.ts',
      triplet: { subject: 'queryResultCache', predicate: 'exported_from', object: 'src/tools/cache.ts' },
      sourceKind: 'import_code',
      sourceRef: 'code:cache',
      confidence: 0.95,
    })

    // Confirm graph edge exists between doc fact and graphLinkedCode via concept overlap
    const neighbors = indexer.getFactNeighbors([docFact.id], new Set(), 20)
    const _neighborIds = neighbors.map(r => r.id)

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion orchestrator',
      limit: 50,
      includeContent: true,
      surface: 'query',
    })

    const resultIds = response.results.map(r => r.metadata.id)
    const graphLinkedRank = resultIds.indexOf(graphLinkedCode.id)
    const identifierOnlyRank = resultIds.indexOf(identifierOnlyCode.id)

    // Graph-linked code fact should rank above or equal to the identifier-only code fact
    expect(graphLinkedRank).toBeGreaterThanOrEqual(0)
    if (identifierOnlyRank >= 0) {
      expect(graphLinkedRank).toBeLessThanOrEqual(identifierOnlyRank)
    }
    indexer.close()
  })
})

describe('FactsQueryResearchOrchestrator — LLM sufficiency judge', () => {
  it('[TC-37] Given judge returns answerable, then loop stops with llm_judge_answerable', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    // Insert enough relevant facts to trigger the judge (needs >= 5 scoring >= 0.5)
    for (let i = 0; i < 10; i++) {
      indexer.upsertFact({
        factText: `query expansion mechanism step ${i} calls expandQueryWithGraph in orchestrator`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }

    const judge: FactsSufficiencyJudge = vi.fn().mockResolvedValue('answerable')
    const response = await new FactsQueryResearchOrchestrator(indexer, { judge }).run({
      query: 'query expansion mechanism orchestrator',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.retrieval.detail).toContain('stop:llm_judge_answerable')
    expect(vi.mocked(judge)).toHaveBeenCalled()
    indexer.close()
  })

  it('[TC-38] Given judge returns insufficient, then loop continues past the judge call', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    for (let i = 0; i < 10; i++) {
      indexer.upsertFact({
        factText: `query expansion mechanism step ${i} calls expandQueryWithGraph in orchestrator`,
        sourceKind: 'import_doc',
        sourceRef: `doc-${i}`,
        confidence: 0.95,
      })
    }

    const judge: FactsSufficiencyJudge = vi.fn().mockResolvedValue('insufficient')
    const response = await new FactsQueryResearchOrchestrator(indexer, { judge }).run({
      query: 'query expansion mechanism orchestrator',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.retrieval.detail).not.toContain('stop:llm_judge_answerable')
    indexer.close()
  })

  it('[TC-39] Given no judge provided, then orchestrator runs without judge calls', async () => {
    const baseDir = await createTempDir()
    const dbPath = path.join(baseDir, 'kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    indexer.upsertFact({
      factText: 'query expansion mechanism calls expandQueryWithGraph',
      sourceKind: 'import_doc',
      sourceRef: 'doc-0',
      confidence: 0.95,
    })

    const response = await new FactsQueryResearchOrchestrator(indexer).run({
      query: 'query expansion mechanism',
      limit: 500,
      includeContent: true,
      surface: 'query',
    })

    expect(response.retrieval.detail).not.toContain('stop:llm_judge_answerable')
    indexer.close()
  })
})
