import { describe, expect, it } from 'vitest'
import {
  INIT_SYNTHESIS_OPENAI_JSON_SCHEMA,
  parseInitSynthesisObject,
  stripSynthesisJsonWrapper,
} from '@kb/core/core/init-synthesis-json.js'

describe('stripSynthesisJsonWrapper', () => {
  it('[TC-72] Given fenced JSON whose body contains triple backticks in a string, then does not truncate early', () => {
    const body = [
      '```json',
      '{"title":"X","type":"reference","tags":[],"content":"see ```npm``` here"}',
      '```',
    ].join('\n')
    const stripped = stripSynthesisJsonWrapper(body)
    expect(stripped).toContain('```npm')
    expect(stripped.startsWith('{')).toBe(true)
    expect(parseInitSynthesisObject(body)?.content).toBe('see ```npm``` here')
  })

  it('[TC-73] Given prose then fenced JSON, then returns inner JSON only when full closing fence exists', () => {
    const body = [
      'Here:',
      '```json',
      '{"title":"A","type":"reference","tags":[],"content":"b"}',
      '```',
    ].join('\n')
    expect(stripSynthesisJsonWrapper(body)).toBe(
      '{"title":"A","type":"reference","tags":[],"content":"b"}'
    )
  })
})

describe('parseInitSynthesisObject', () => {
  it('[TC-74] Given balanced JSON object, then returns doc fields', () => {
    const doc = parseInitSynthesisObject(
      '{"title":"  Hello ","type":"introduction","tags":["a"],"content":"# Body\\n"}'
    )
    expect(doc).toEqual({
      title: 'Hello',
      type: 'introduction',
      tags: ['a'],
      content: '# Body\n',
    })
  })

  it('[TC-75] Given INIT_SYNTHESIS_OPENAI_JSON_SCHEMA shape, then schema is strict-ready', () => {
    expect(INIT_SYNTHESIS_OPENAI_JSON_SCHEMA.type).toBe('object')
    expect(INIT_SYNTHESIS_OPENAI_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(INIT_SYNTHESIS_OPENAI_JSON_SCHEMA.required).toEqual(
      expect.arrayContaining(['title', 'type', 'tags', 'content'])
    )
  })
})
