import { describe, expect, it, vi } from 'vitest'
import type { ReadDocumentsResultItem } from '../../src/cli/intent-cli'
import type { LLMProvider } from '../../src/core/types'
import {
  llmExtractQueryEntities,
  rerankByGraphConnectivity,
} from '../../src/tools/graph-rag-reranker'
import type { KbGraphWriter } from '../../src/tools/kb-graph-writer'
import type { CodeGraphStore } from '../../src/tools/code-graph-store'

function makeResult(id: string, content: string, graphEvidence?: string[]): ReadDocumentsResultItem {
  return { metadata: { id }, content, graphEvidence }
}

function makeLLM(text: string): LLMProvider {
  return {
    name: 'test',
    model: 'stub',
    call: vi.fn(async () => ({ text, usage: { inputTokens: 1, outputTokens: 1 } })),
  } as unknown as LLMProvider
}

function makeGraphWriter(neighborTerms: string[] = []): KbGraphWriter {
  return {
    expandQuery: vi.fn(async () => neighborTerms),
  } as unknown as KbGraphWriter
}

function makeCodeStore(names: string[] = []): CodeGraphStore {
  return {
    findCodeSymbolsByName: vi.fn(() => names.map(name => ({ name }))),
  } as unknown as CodeGraphStore
}

describe('llmExtractQueryEntities', () => {
  it('[TC-16] parses a valid JSON array from LLM response', async () => {
    const llm = makeLLM('["TsMorphIndexer", "code-graph-indexer", "AST"]')
    const entities = await llmExtractQueryEntities('what class handles AST generation?', llm)
    expect(entities).toEqual(['TsMorphIndexer', 'code-graph-indexer', 'AST'])
  })

  it('[TC-17] extracts array even when surrounded by prose', async () => {
    const llm = makeLLM('Here are the entities: ["KbGraphWriter", "SQLite"] for your query.')
    const entities = await llmExtractQueryEntities('how does the graph store work?', llm)
    expect(entities).toEqual(['KbGraphWriter', 'SQLite'])
  })

  it('[TC-18] returns empty array when LLM returns non-JSON', async () => {
    const llm = makeLLM('I cannot extract entities from this.')
    const entities = await llmExtractQueryEntities('what is the meaning of life?', llm)
    expect(entities).toEqual([])
  })

  it('[TC-19] returns empty array when LLM call throws', async () => {
    const llm = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => { throw new Error('network error') }),
    } as unknown as LLMProvider
    const entities = await llmExtractQueryEntities('some query', llm)
    expect(entities).toEqual([])
  })

  it('[TC-20] caps results at 8 entities', async () => {
    const many = JSON.stringify(['a','b','c','d','e','f','g','h','i','j'])
    const llm = makeLLM(many)
    const entities = await llmExtractQueryEntities('query', llm)
    expect(entities.length).toBeLessThanOrEqual(8)
  })
})

describe('rerankByGraphConnectivity', () => {
  it('[TC-21] returns results unchanged when no entities given', async () => {
    const results = [makeResult('a', 'foo'), makeResult('b', 'bar')]
    const out = await rerankByGraphConnectivity(results, [], makeGraphWriter(), makeCodeStore())
    expect(out.map(r => r.metadata?.id)).toEqual(['a', 'b'])
  })

  it('[TC-22] returns results unchanged when fewer than 2 results', async () => {
    const results = [makeResult('only', 'TsMorphIndexer handles AST')]
    const out = await rerankByGraphConnectivity(results, ['TsMorphIndexer'], makeGraphWriter(['TsMorphIndexer']), makeCodeStore())
    expect(out).toHaveLength(1)
  })

  it('[TC-23] boosts result whose content matches graph neighborhood terms', async () => {
    const results = [
      makeResult('generic', 'kb maintains a knowledge graph for documents'),
      makeResult('specific', 'TsMorphIndexer builds the code graph using TypeScript compiler'),
    ]
    // graph expansion returns TsMorphIndexer as a neighbor
    const graphWriter = makeGraphWriter(['TsMorphIndexer', 'TypeScript compiler'])
    const out = await rerankByGraphConnectivity(results, ['TsMorphIndexer'], graphWriter, makeCodeStore())
    expect(out[0]?.metadata?.id).toBe('specific')
  })

  it('[TC-24] boosts result whose graphEvidence matches', async () => {
    const results = [
      makeResult('unrelated', 'some unrelated content about nothing'),
      makeResult('connected', 'general fact', ['TsMorphIndexer implements code-graph-indexer']),
    ]
    const graphWriter = makeGraphWriter(['TsMorphIndexer'])
    const out = await rerankByGraphConnectivity(results, ['TsMorphIndexer'], graphWriter, makeCodeStore())
    expect(out[0]?.metadata?.id).toBe('connected')
  })

  it('[TC-25] preserves original order when connectivity scores are equal', async () => {
    const results = [
      makeResult('first', 'unrelated content one'),
      makeResult('second', 'unrelated content two'),
    ]
    const out = await rerankByGraphConnectivity(results, ['TsMorphIndexer'], makeGraphWriter([]), makeCodeStore())
    expect(out.map(r => r.metadata?.id)).toEqual(['first', 'second'])
  })

  it('[TC-26] returns original results when graphWriter.expandQuery throws', async () => {
    const results = [makeResult('a', 'foo'), makeResult('b', 'bar')]
    const brokenGraph = {
      expandQuery: vi.fn(async () => { throw new Error('db error') }),
    } as unknown as KbGraphWriter
    const out = await rerankByGraphConnectivity(results, ['TsMorphIndexer'], brokenGraph)
    expect(out).toEqual(results)
  })
})
