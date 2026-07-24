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
            metadata: { id: 'doc-1', title: 'Base Selection', filePath: 'src/cli/base-selection.ts', tags: ['cli'] },
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
