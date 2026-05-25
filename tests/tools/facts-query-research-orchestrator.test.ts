import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPondQueries,
  FactsQueryResearchOrchestrator,
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
})

describe('FactsQueryResearchOrchestrator ponds', () => {
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
