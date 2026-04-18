import { describe, expect, it } from 'vitest'
import {
  extractBalancedJsonObject,
  parseGraphExtractorJson,
} from '../../src/tools/graph-entity-extractor'

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
