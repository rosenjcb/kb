import { describe, expect, it } from 'vitest'
import type { IntentResult } from '@kb/core/intents/types.js'
import { serializeQueryResult } from '@kb/core/service/serialize.js'

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
