import { describe, expect, it } from 'vitest'
import type { IntentResult } from '@kb/core/intents/types.js'
import {
  findUngroundedFileReferences,
  serializeMcpQueryResult,
  serializeQueryResult,
} from '@kb/core/service/serialize.js'

describe('serializeQueryResult', () => {
  it('[TC-34] maps a read_facts IntentResult into the REST response body', () => {
    const result: IntentResult = {
      status: 'accepted',
      recommendedAction: 'read_facts',
      confidence: 0.82,
      data: {
        answer: '  Base resolution walks up for a .kb file.  ',
        results: [
          {
            metadata: {
              id: 'doc-1',
              title: 'Base Selection',
              filePath: 'src/cli/base-selection.ts',
              tags: ['cli'],
            },
            content: '# Heading\nResolves the active base from config.activeBase then defaultBase.',
          },
        ],
        retrieval: { method: 'hybrid', detail: 'deep' },
      },
    }

    const body = serializeQueryResult(result)

    expect(body.status).toBe('accepted')
    expect(body.answer).toBe('Base resolution walks up for a .kb file.')
    expect(body.confidence).toBe(0.82)
    expect(body.retrieval).toEqual({ method: 'hybrid', detail: 'deep' })
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({
      id: 'doc-1',
      title: 'Base Selection',
      filePath: 'src/cli/base-selection.ts',
      tags: ['cli'],
    })
    // Snippet drops markdown headings.
    expect(body.results[0].snippet).toContain('Resolves the active base')
    expect(body.results[0].snippet).not.toContain('# Heading')
  })

  it('[TC-35] returns null answer when none is present', () => {
    const body = serializeQueryResult({ status: 'accepted', data: { results: [] } })
    expect(body.answer).toBeNull()
    expect(body.results).toEqual([])
    expect(body.confidence).toBeUndefined()
  })

  it('[TC-39] surfaces the physical sourcePath (+symbol) as the location, not the fact:// URI', () => {
    const body = serializeQueryResult({
      status: 'accepted',
      data: {
        results: [
          {
            metadata: {
              id: 'fact-1',
              title: 'AST parsers',
              filePath: 'fact://abc123',
              sourcePath: 'src/ast/langs/typescript.ts',
              symbol: 'parseModule',
              tags: ['import_code', 'fact'],
            },
            content: 'Parses a TypeScript module into AST nodes.',
          },
        ],
      },
    })
    // filePath must be the openable physical path, never the opaque fact:// id.
    expect(body.results[0].filePath).toBe('src/ast/langs/typescript.ts')
    expect(body.results[0].symbol).toBe('parseModule')
    expect(body.results[0].filePath).not.toContain('fact://')
  })

  it('[TC-40] falls back to the fact:// URI when no physical sourcePath is known', () => {
    const body = serializeQueryResult({
      status: 'accepted',
      data: {
        results: [{ metadata: { id: 'fact-2', title: 't', filePath: 'fact://def456' } }],
      },
    })
    expect(body.results[0].filePath).toBe('fact://def456')
  })

  it('[TC-36] includes traceFile when the retrieval wrote a deep trace dump', () => {
    const body = serializeQueryResult({
      status: 'accepted',
      data: {
        results: [],
        traceFile: '/tmp/kb/traces/qtrace-1.json',
      },
    })
    expect(body.traceFile).toBe('/tmp/kb/traces/qtrace-1.json')
  })
})

function factItem(sourcePath: string, symbol?: string, id = sourcePath) {
  return {
    metadata: { id, title: id, sourcePath, ...(symbol ? { symbol } : {}) },
    content: `About ${sourcePath}.`,
  }
}

describe('serializeMcpQueryResult', () => {
  it('[TC-111] trims to answer + citations and drops retrieval metadata and the fact dump', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      confidence: 0.9,
      data: {
        answer: 'Login flows through `login.ts` and `session.ts`.',
        results: [factItem('src/auth/login.ts', 'loginHandler'), factItem('src/auth/session.ts')],
        retrieval: { method: 'facts-loop', detail: 'passes:1;ponds:6;stop:answerable_plateau' },
      },
    })
    expect(body).toEqual({
      status: 'accepted',
      answer: 'Login flows through `login.ts` and `session.ts`.',
      sources: ['src/auth/login.ts (loginHandler)', 'src/auth/session.ts'],
      confidence: 0.9,
    })
  })

  it('[TC-112] adds a verify note when confidence is below the threshold', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      confidence: 0.5,
      data: {
        answer: 'Something about `login.ts`.',
        results: [factItem('src/auth/login.ts')],
        retrieval: {},
      },
    })
    expect(body.notes).toEqual([
      'Confidence 0.50 — verify the cited sources before relying on this answer.',
    ])
  })

  it('[TC-113] dedupes citations per file, folds in symbols, and caps the list at 5', () => {
    const results = [
      factItem('src/a.ts', 'alpha', 'f1'),
      factItem('src/a.ts', 'beta', 'f2'),
      factItem('src/b.ts', undefined, 'f3'),
      factItem('src/c.ts', undefined, 'f4'),
      factItem('src/d.ts', undefined, 'f5'),
      factItem('src/e.ts', undefined, 'f6'),
      factItem('src/f.ts', undefined, 'f7'),
    ]
    const body = serializeMcpQueryResult({
      status: 'accepted',
      data: { answer: 'See `a.ts`.', results, retrieval: {} },
    })
    expect(body.sources).toHaveLength(5)
    expect(body.sources[0]).toBe('src/a.ts (alpha, beta)')
    expect(body.sources).not.toContain('src/f.ts')
  })

  it('[TC-114] flags answer file references that match no cited source path', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      data: {
        answer: 'The schema lives in `dto.ts` next to **reversal.ts**.',
        results: [factItem('packages/common/reversal.ts', 'ReversalSchema')],
        retrieval: {},
      },
    })
    expect(body.notes).toHaveLength(1)
    expect(body.notes?.[0]).toContain('dto.ts')
    expect(body.notes?.[0]).not.toContain('reversal.ts')
    expect(body.notes?.[0]).toContain('trust the sources list')
  })

  it('[TC-115] notes when sources exist but no answer was synthesized', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      data: { results: [factItem('src/a.ts')], retrieval: {} },
    })
    expect(body.answer).toBeNull()
    expect(body.notes).toEqual([
      'No synthesized answer was produced — open the cited sources directly.',
    ])
  })
})

describe('findUngroundedFileReferences', () => {
  it('[TC-116] matches by basename so relative prose paths ground against absolute evidence paths', () => {
    const refs = findUngroundedFileReferences(
      'Resolution happens in `src/cli/base-selection.ts`.',
      ['packages/kb-client/src/cli/base-selection.ts']
    )
    expect(refs).toEqual([])
  })

  it('[TC-117] ignores non-file tokens: product names, property access, bare words', () => {
    const refs = findUngroundedFileReferences(
      'Node.js reads data.results and config.activeBase, e.g. at startup.',
      []
    )
    expect(refs).toEqual([])
  })

  it('[TC-118] reports each ungrounded file once', () => {
    const refs = findUngroundedFileReferences('`dto.ts` … see dto.ts and `other.py`.', [
      'src/real.ts',
    ])
    expect(refs).toEqual(['dto.ts', 'other.py'])
  })
})

describe('synthesis failure surfacing', () => {
  const failure = {
    stage: 'synthesis',
    kind: 'insufficient_credits',
    message: '[anthropic] API request failed (400): Your credit balance is too low',
    provider: 'anthropic',
    status: 400,
    retryable: false,
  }

  const resultWithFailure = {
    status: 'accepted' as const,
    recommendedAction: 'read_facts',
    data: {
      answerError: failure,
      retrieval: { method: 'facts-loop' },
      results: [
        {
          metadata: { id: 'f1', title: 'Auth', sourcePath: 'src/auth/login.ts' },
          content: 'Handles login.',
        },
      ],
    },
  }

  it('[TC-156] Given synthesis failed, then the REST body carries answerError alongside the sources', () => {
    const body = serializeQueryResult(resultWithFailure)
    expect(body.answer).toBeNull()
    expect(body.answerError).toEqual(failure)
    // Retrieval succeeded, so the caller still gets something actionable.
    expect(body.results).toHaveLength(1)
  })

  it('[TC-157] Given synthesis failed, then the MCP note names the outage instead of blaming the evidence', () => {
    const body = serializeMcpQueryResult(resultWithFailure)
    expect(body.answer).toBeNull()
    expect(body.answerError).toEqual(failure)
    const notes = body.notes ?? []
    // The failure leads: an agent reading "open the cited sources directly" would wrongly
    // conclude the KB is thin and stop retrying.
    expect(notes[0]).toContain('insufficient_credits')
    expect(notes[0]).toContain('billing')
    expect(notes.join(' ')).not.toContain('No synthesized answer was produced')
  })

  it('[TC-158] Given a degraded best-effort stage, then the payload says ranking is weaker than usual', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: {
        answer: 'An answer.',
        retrieval: {
          method: 'facts-loop',
          degraded: [
            {
              stage: 'curation',
              kind: 'rate_limit',
              message: '[anthropic] API request failed (429): slow down',
              provider: 'anthropic',
              status: 429,
              retryable: true,
            },
          ],
        },
        results: [{ metadata: { id: 'f1', title: 'Auth', sourcePath: 'src/a.ts' } }],
      },
    })
    expect(body.answer).toBe('An answer.')
    expect((body.notes ?? []).join(' ')).toContain('curation (rate_limit)')
  })

  it('[TC-159] Given no answer and no failure, then the original evidence note is unchanged', () => {
    const body = serializeMcpQueryResult({
      status: 'accepted',
      recommendedAction: 'read_facts',
      data: {
        retrieval: { method: 'facts-loop' },
        results: [{ metadata: { id: 'f1', title: 'Auth', sourcePath: 'src/a.ts' } }],
      },
    })
    expect(body.notes).toEqual([
      'No synthesized answer was produced — open the cited sources directly.',
    ])
    expect(body.answerError).toBeUndefined()
  })
})
