import { describe, expect, it } from 'vitest'
import {
  extractBalancedJsonObject,
  extractGraphBatch,
  parseGraphExtractorJson,
} from '../../src/tools/graph-entity-extractor'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'

describe('extractBalancedJsonObject', () => {
  it('Given prose before JSON, then returns first balanced object', () => {
    const src = `Here you go:
{"entities":[{"id":"kb","name":"KB","type":"tool"}],"relationships":[]}
Thanks.`
    expect(extractBalancedJsonObject(src)).toBe(
      '{"entities":[{"id":"kb","name":"KB","type":"tool"}],"relationships":[]}'
    )
  })

  it('Given braces inside strings, then does not terminate early', () => {
    const inner = '{"id":"x","name":"Has { curlies }","type":"concept"}'
    const src = `{"entities":[${inner}],"relationships":[]}`
    expect(extractBalancedJsonObject(src)).toBe(src)
  })
})

describe('parseGraphExtractorJson', () => {
  it('Given markdown fenced JSON, then parses entities', () => {
    const raw =
      '```json\n{"entities":[{"id":"a","name":"A","type":"system"}],"relationships":[]}\n```'
    const g = parseGraphExtractorJson(raw, 'doc-1')
    expect(g.entities).toHaveLength(1)
    expect(g.entities[0].docId).toBe('doc-1')
  })

  it('Given preamble plus JSON object, then parses via balanced slice', () => {
    const raw = `Sure — extracted graph below.

{"entities":[{"id":"readme","name":"README","type":"concept"}],"relationships":[]}`
    const g = parseGraphExtractorJson(raw)
    expect(g.entities.map(e => e.id)).toContain('readme')
  })
})

describe('extractGraphBatch', () => {
  it('reports cumulative progress after each batch', async () => {
    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      async call(params: LLMCallParams): Promise<LLMResponse> {
        const text = params.messages.at(0)?.content
        if (typeof text === 'string' && text.includes('Doc A')) {
          return {
            text: JSON.stringify({
              entities: [
                { id: 'a', name: 'A', type: 'concept' },
                { id: 'shared', name: 'Shared', type: 'concept' },
              ],
              relationships: [{ fromId: 'a', toId: 'shared', type: 'uses' }],
            }),
            stopReason: 'end_turn',
            toolUses: [],
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        }
        return {
          text: JSON.stringify({
            entities: [
              { id: 'b', name: 'B', type: 'concept' },
              { id: 'shared', name: 'Shared', type: 'concept' },
            ],
            relationships: [{ fromId: 'b', toId: 'shared', type: 'uses' }],
          }),
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      },
    }

    const snapshots: Array<{
      docsProcessed: number
      totalDocs: number
      totalEntities: number
      totalRelationships: number
    }> = []

    const graph = await extractGraphBatch(
      [
        { id: 'doc-a', text: 'Doc A' },
        { id: 'doc-b', text: 'Doc B' },
      ],
      provider,
      {
        onProgress(progress) {
          snapshots.push({
            docsProcessed: progress.docsProcessed,
            totalDocs: progress.totalDocs,
            totalEntities: progress.totalEntities,
            totalRelationships: progress.totalRelationships,
          })
        },
      }
    )

    expect(graph.entities.map(e => e.id).sort()).toEqual(['a', 'b', 'shared'])
    expect(graph.relationships).toHaveLength(2)
    expect(snapshots).toEqual([
      {
        docsProcessed: 2,
        totalDocs: 2,
        totalEntities: 3,
        totalRelationships: 2,
      },
    ])
  })
})
