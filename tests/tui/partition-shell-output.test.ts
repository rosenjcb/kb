import { describe, expect, it } from 'vitest'
import { partitionShellOutputForTui } from '../../src/tui/partition-shell-output'

describe('tui/partitionShellOutputForTui', () => {
  it('output with no meta lines → one body segment', () => {
    const { segments } = partitionShellOutputForTui('Hello world\nSecond line')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ kind: 'body', text: 'Hello world\nSecond line' })
  })

  it('empty output → no body segments', () => {
    const { segments, emptyPrimaryContent } = partitionShellOutputForTui('')
    const bodySegments = segments.filter(s => s.kind === 'body')
    expect(bodySegments).toHaveLength(0)
    expect(emptyPrimaryContent).toBe('')
  })

  it('only meta lines → no body segments', () => {
    const { segments, emptyPrimaryContent } = partitionShellOutputForTui(
      'retrieval> hybrid\nmatches> 5'
    )
    const bodySegs = segments.filter(s => s.kind === 'body')
    const metaSegs = segments.filter(s => s.kind === 'meta')
    expect(bodySegs).toHaveLength(0)
    expect(metaSegs).toHaveLength(2)
    expect(emptyPrimaryContent).toBe('')
  })

  it('meta line splits body into two segments', () => {
    const output = 'Before content\nsep> —\nAfter content'
    const { segments } = partitionShellOutputForTui(output)
    const bodies = segments.filter(s => s.kind === 'body')
    const metas = segments.filter(s => s.kind === 'meta')
    expect(bodies).toHaveLength(2)
    expect(metas).toHaveLength(1)
    expect(metas[0]).toEqual({ kind: 'meta', line: 'sep> —' })
  })

  it('evidence> items each on their own wire-key line → all grey meta', () => {
    const output = [
      'Final answer text',
      'sep> —',
      'evidence> - item 1 (source: fact://abc)',
      'evidence> - item 2 (source: fact://def)',
      'retrieval> hybrid',
    ].join('\n')
    const { segments } = partitionShellOutputForTui(output)
    const metaLines = segments.filter(s => s.kind === 'meta').map(s => (s as { kind: 'meta'; line: string }).line)
    expect(metaLines).toContain('sep> —')
    expect(metaLines).toContain('evidence> - item 1 (source: fact://abc)')
    expect(metaLines).toContain('evidence> - item 2 (source: fact://def)')
    expect(metaLines).toContain('retrieval> hybrid')
    const bodies = segments.filter(s => s.kind === 'body')
    expect(bodies).toHaveLength(1)
    expect((bodies[0] as { kind: 'body'; text: string }).text).toBe('Final answer text')
  })

  it('assistant> lines are NOT meta — they are body', () => {
    const output = 'assistant> The answer is here'
    const { segments } = partitionShellOutputForTui(output)
    expect(segments[0].kind).toBe('body')
  })

  it('emptyPrimaryContent is non-empty only when there is body content', () => {
    const withBody = partitionShellOutputForTui('some answer')
    expect(withBody.emptyPrimaryContent).toBe('some answer')

    const metaOnly = partitionShellOutputForTui('retrieval> hybrid')
    expect(metaOnly.emptyPrimaryContent).toBe('')
  })
})
