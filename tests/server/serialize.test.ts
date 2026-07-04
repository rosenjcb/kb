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
})
