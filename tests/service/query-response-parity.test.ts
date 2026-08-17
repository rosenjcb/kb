import { describe, expect, it } from 'vitest'
import type { IntentResult } from '@kb/core/intents/types.js'
import { serializeMcpQueryResult, serializeQueryResult } from '@kb/core/service/serialize.js'
import { createPrinter } from '@kb/client/ui/printer.js'

function factItem(sourcePath: string, symbol?: string, id = sourcePath) {
  return {
    metadata: { id, title: id, sourcePath, ...(symbol ? { symbol } : {}) },
    content: `About ${sourcePath}.`,
  }
}

describe('serializeQueryResult', () => {
  it('[TC-GEV5] resolves source hrefs when a source-repo registry is provided', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        data: {
          results: [{ metadata: { id: 'f1', sourcePath: 'rosenjcb-kb/src/a.ts' } }],
        },
      },
      {
        sourceRepos: [
          {
            slug: 'rosenjcb-kb',
            browseUrl: 'https://github.com/rosenjcb/kb',
            branch: 'main',
          },
        ],
      },
    )
    expect(body.sources).toEqual([
      {
        path: 'src/a.ts',
        label: 'src/a.ts',
        href: 'https://github.com/rosenjcb/kb/blob/main/src/a.ts',
        symbols: [],
        facts: [{ id: 'f1' }],
        factCount: 1,
      },
    ])
  })

  it('[TC-0T3O] keeps REST and MCP grounding semantics identical', () => {
    const result: IntentResult = {
      status: 'accepted',
      evidence: 'strong' as const,
      data: {
        answer: 'The schema lives in `dto.ts` and import persists to backend.',
        results: [factItem('packages/common/reversal.ts', 'ReversalSchema')],
        retrieval: {
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
          unsupportedClaims: ['import persists to backend'],
        },
      },
    }
    const rest = serializeQueryResult(result)
    const mcp = serializeMcpQueryResult(result)
    expect(rest.evidence).toBe('weak')
    expect(mcp.evidence).toBe('weak')
    expect(mcp.notes).toEqual(rest.notes)
  })
})

describe('ui/printer', () => {
  it('[TC-TBPH] sourceCitation renders grouped symbols on the same source line', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
      },
      'cli'
    )

    printer.sourceCitation('src/a.ts', { symbols: ['alpha', 'beta'] })

    expect(lines).toEqual(['source> src/a.ts · alpha, beta'])
  })
})
