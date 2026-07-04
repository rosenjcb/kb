import { describe, expect, it } from 'vitest'
import { partitionShellOutputForTui } from '@kb/client/tui/partition-shell-output.js'

describe('tui/partitionShellOutputForTui', () => {
  it('[TC-46] output with no meta lines → one body segment', () => {
    const { segments } = partitionShellOutputForTui('Hello world\nSecond line')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ kind: 'body', text: 'Hello world\nSecond line' })
  })

  it('[TC-47] empty output → no body segments', () => {
    const { segments, emptyPrimaryContent } = partitionShellOutputForTui('')
    const bodySegments = segments.filter(s => s.kind === 'body')
    expect(bodySegments).toHaveLength(0)
    expect(emptyPrimaryContent).toBe('')
  })

  it('[TC-48] only meta lines → no body segments', () => {
    const { segments, emptyPrimaryContent } = partitionShellOutputForTui(
      'retrieval> hybrid\nmatches> 5'
    )
    const bodySegs = segments.filter(s => s.kind === 'body')
    const metaSegs = segments.filter(s => s.kind === 'meta')
    expect(bodySegs).toHaveLength(0)
    expect(metaSegs).toHaveLength(2)
    expect(emptyPrimaryContent).toBe('')
  })

  it('[TC-49] meta line splits body into two segments', () => {
    const output = 'Before content\nsep> —\nAfter content'
    const { segments } = partitionShellOutputForTui(output)
    const bodies = segments.filter(s => s.kind === 'body')
    const metas = segments.filter(s => s.kind === 'meta')
    expect(bodies).toHaveLength(2)
    expect(metas).toHaveLength(1)
    expect(metas[0]).toEqual({ kind: 'meta', line: 'sep> —' })
  })

  it('[TC-50] evidence> summary is a single meta line after the answer', () => {
    const output = [
      'Final answer text',
      'sep> —',
      'evidence> 2 facts → LLM (full text) · mix: all doc · themes: cli · leads: A, B · walk: 3p/2h/2 ponds · stop: budget_exhausted · conf: 0.80',
      'retrieval> hybrid',
    ].join('\n')
    const { segments } = partitionShellOutputForTui(output)
    const metaLines = segments.filter(s => s.kind === 'meta').map(s => (s as { kind: 'meta'; line: string }).line)
    expect(metaLines).toContain('sep> —')
    expect(metaLines.filter(line => line.startsWith('evidence>'))).toHaveLength(1)
    expect(metaLines.some(line => line.includes('facts → LLM (full text)'))).toBe(true)
    expect(metaLines).toContain('retrieval> hybrid')
    const bodies = segments.filter(s => s.kind === 'body')
    expect(bodies).toHaveLength(1)
    expect((bodies[0] as { kind: 'body'; text: string }).text).toBe('Final answer text')
  })

  it('[TC-51] assistant> lines are NOT meta — they are body', () => {
    const output = 'assistant> The answer is here'
    const { segments } = partitionShellOutputForTui(output)
    expect(segments[0].kind).toBe('body')
  })

  it('[TC-52] emptyPrimaryContent is non-empty only when there is body content', () => {
    const withBody = partitionShellOutputForTui('some answer')
    expect(withBody.emptyPrimaryContent).toBe('some answer')

    const metaOnly = partitionShellOutputForTui('retrieval> hybrid')
    expect(metaOnly.emptyPrimaryContent).toBe('')
  })

  it('[TC-53] real-world /query output: stage lines are meta, answer prose is body', () => {
    // Reproduces the bug: answer text between stage>answer:done and sep> must be a body segment.
    const output = [
      'stage> answer:start',
      'stage> answer:done 5137ms',
      'To add Haskell support, modify the SKILLS array in src/cli/init-cli.ts.',
      'sep> —',
      'evidence> 381 facts → LLM (full text) · mix: all doc · themes: CLI, Init/Scan',
      'retrieval> hybrid (facts-loop;passes:1)',
      'matches> 381 ranked facts',
    ].join('\n')

    const { segments } = partitionShellOutputForTui(output)
    const bodies = segments.filter(s => s.kind === 'body')
    const metas = segments.filter(s => s.kind === 'meta')

    // The answer prose must be the only body segment
    expect(bodies).toHaveLength(1)
    expect((bodies[0] as { kind: 'body'; text: string }).text).toBe(
      'To add Haskell support, modify the SKILLS array in src/cli/init-cli.ts.'
    )

    // All stage/sep/evidence/retrieval/matches lines are meta
    const metaLines = metas.map(s => (s as { kind: 'meta'; line: string }).line)
    expect(metaLines).toContain('stage> answer:start')
    expect(metaLines).toContain('stage> answer:done 5137ms')
    expect(metaLines).toContain('sep> —')
    expect(metaLines.some(l => l.startsWith('evidence>'))).toBe(true)
    expect(metaLines).toContain('retrieval> hybrid (facts-loop;passes:1)')
    expect(metaLines).toContain('matches> 381 ranked facts')
  })

  it('[TC-54] first body segment index is stable so primary-first ordering works', () => {
    // Validates the App.tsx fix: firstBodyIdx must point to the answer prose, not a meta line.
    const output = [
      'stage> answer:start',
      'stage> answer:done 5137ms',
      'The answer is here.',
      'sep> —',
      'evidence> 10 facts',
    ].join('\n')

    const { segments } = partitionShellOutputForTui(output)
    const firstBodyIdx = segments.findIndex(s => s.kind === 'body')

    expect(firstBodyIdx).toBeGreaterThan(-1)
    expect(segments[firstBodyIdx]).toEqual({ kind: 'body', text: 'The answer is here.' })
    // All segments before the first body must be meta
    for (let i = 0; i < firstBodyIdx; i++) {
      expect(segments[i].kind).toBe('meta')
    }
  })
})
