import type { IntentResult } from '@kb/core/intents/types.js'
import {
  findUngroundedFileReferences,
  serializeMcpQueryResult,
  serializeQueryResult,
} from '@kb/core/service/serialize.js'
import { describe, expect, it } from 'vitest'

describe('serializeQueryResult', () => {
  it('[TC-17SF] maps a read_facts IntentResult into the REST response body', () => {
    const result: IntentResult = {
      status: 'accepted',
      recommendedAction: 'read_facts',
      evidence: 'strong' as const,
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

    const body = serializeQueryResult(result, { sourceRepos: [] })

    expect(body.status).toBe('accepted')
    expect(body.answer).toBe('Base resolution walks up for a .kb file.')
    expect(body.evidence).toBe('strong')
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

  it('[TC-0CD9] returns null answer when none is present', () => {
    const body = serializeQueryResult(
      { status: 'accepted', data: { results: [] } },
      { sourceRepos: [] }
    )
    expect(body.answer).toBeNull()
    expect(body.results).toEqual([])
    expect(body.evidence).toBeUndefined()
  })

  it('[TC-C759] surfaces the physical sourcePath (+symbol) as the location, not the fact:// URI', () => {
    const body = serializeQueryResult(
      {
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
      },
      { sourceRepos: [] }
    )
    // filePath must be the openable physical path, never the opaque fact:// id.
    expect(body.results[0].filePath).toBe('src/ast/langs/typescript.ts')
    expect(body.results[0].symbol).toBe('parseModule')
    expect(body.results[0].filePath).not.toContain('fact://')
  })

  it('[TC-L9F8] falls back to the fact:// URI when no physical sourcePath is known', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        data: {
          results: [{ metadata: { id: 'fact-2', title: 't', filePath: 'fact://def456' } }],
        },
      },
      { sourceRepos: [] }
    )
    expect(body.results[0].filePath).toBe('fact://def456')
  })

  it('[TC-C4IU] exposes source-centric `sources` (files, symbols folded, non-openable dropped)', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        data: {
          results: [
            { metadata: { id: 'f1', title: 'a', sourcePath: 'src/a.ts', symbol: 'alpha' } },
            { metadata: { id: 'f2', title: 'a', sourcePath: 'src/a.ts', symbol: 'beta' } },
            { metadata: { id: 'f3', title: 'unknown', filePath: 'fact://deadbeef' } },
          ],
        },
      },
      { sourceRepos: [] }
    )
    // Two facts for src/a.ts collapse to one file with both symbols; the fact:// row drops.
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]).toMatchObject({
      path: 'src/a.ts',
      symbols: ['alpha', 'beta'],
      factCount: 2,
    })
    // The raw per-fact rows are still available.
    expect(body.results).toHaveLength(3)
  })

  it('[TC-6JDU] includes traceFile when the retrieval wrote a deep trace dump', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        data: {
          results: [],
          traceFile: '/tmp/kb/traces/qtrace-1.json',
        },
      },
      { sourceRepos: [] }
    )
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
  it('[TC-7277] trims to answer + lean citations and drops retrieval metadata and the fact dump', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        evidence: 'strong' as const,
        data: {
          answer: 'Login flows through `login.ts` and `session.ts`.',
          results: [factItem('src/auth/login.ts', 'loginHandler'), factItem('src/auth/session.ts')],
          retrieval: { method: 'facts-loop', detail: 'passes:1;ponds:6;stop:answerable_plateau' },
        },
      },
      { sourceRepos: [] }
    )
    expect(body).toEqual({
      status: 'accepted',
      answer: 'Login flows through `login.ts` and `session.ts`.',
      sources: [
        { path: 'src/auth/login.ts', symbols: ['loginHandler'] },
        { path: 'src/auth/session.ts' },
      ],
      evidence: 'strong',
    })
    expect(body).not.toHaveProperty('results')
    expect(body).not.toHaveProperty('retrieval')
  })

  it('[TC-6KDA] carries both citation forms: repo-relative path and blob href', () => {
    // The lean payload used to regroup without the registry, so an agent got a
    // clone-slug path and never got a link. Both forms come from one registry.
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: {
          answer: 'Login flows through `login.ts`.',
          results: [factItem('rosenjcb-kb/src/auth/login.ts', 'loginHandler')],
          retrieval: {},
        },
      },
      {
        sourceRepos: [
          {
            slug: 'rosenjcb-kb',
            browseUrl: 'https://github.com/rosenjcb/kb',
            branch: 'main',
            repoId: 'rosenjcb/kb',
          },
        ],
      }
    )
    expect(body.sources).toEqual([
      {
        path: 'rosenjcb/kb/src/auth/login.ts',
        repo: 'rosenjcb/kb',
        symbols: ['loginHandler'],
        href: 'https://github.com/rosenjcb/kb/blob/main/src/auth/login.ts',
      },
    ])
  })

  it('[TC-Q93N] adds a verify note when evidence is below the floor', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        evidence: 'weak' as const,
        data: {
          answer: 'Something about `login.ts`.',
          results: [factItem('src/auth/login.ts')],
          retrieval: {},
        },
      },
      { sourceRepos: [] }
    )
    expect(body.notes).toEqual([
      'Retrieval evidence was weak — verify the cited sources before relying on this answer.',
    ])
  })

  it('[TC-B7DG] dedupes citations per file, folds in symbols, and caps the list at 5', () => {
    const results = [
      factItem('src/a.ts', 'alpha', 'f1'),
      factItem('src/a.ts', 'beta', 'f2'),
      factItem('src/b.ts', undefined, 'f3'),
      factItem('src/c.ts', undefined, 'f4'),
      factItem('src/d.ts', undefined, 'f5'),
      factItem('src/e.ts', undefined, 'f6'),
      factItem('src/f.ts', undefined, 'f7'),
    ]
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: { answer: 'See `a.ts`.', results, retrieval: {} },
      },
      { sourceRepos: [] }
    )
    expect(body.sources).toHaveLength(5)
    expect(body.sources[0]).toEqual({
      path: 'src/a.ts',
      symbols: ['alpha', 'beta'],
    })
    expect(body.sources.map(s => s.path)).not.toContain('src/f.ts')
  })

  it('[TC-8URR] flags answer file references that match no cited source path', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: {
          answer: 'The schema lives in `dto.ts` next to **reversal.ts**.',
          results: [factItem('packages/common/reversal.ts', 'ReversalSchema')],
          retrieval: {},
        },
      },
      { sourceRepos: [] }
    )
    expect(body.notes).toHaveLength(1)
    expect(body.notes?.[0]).toContain('dto.ts')
    expect(body.notes?.[0]).not.toContain('reversal.ts')
    expect(body.notes?.[0]).toContain('trust the sources list')
  })

  it('[TC-OADK] notes when sources exist but no answer was synthesized', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: { results: [factItem('src/a.ts')], retrieval: {} },
      },
      { sourceRepos: [] }
    )
    expect(body.answer).toBeNull()
    expect(body.notes).toEqual([
      'No synthesized answer was produced — open the cited sources directly.',
    ])
  })

  it('[TC-CA0M] downgrades evidence when the answer cites a file not in the sources', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        evidence: 'strong' as const,
        data: {
          answer: 'The schema lives in `dto.ts`.',
          results: [factItem('packages/common/reversal.ts', 'ReversalSchema')],
          retrieval: {},
        },
      },
      { sourceRepos: [] }
    )
    // A note alone isn't enough — the top-level label an agent scans for must
    // reflect the same mismatch the note describes.
    expect(body.evidence).toBe('weak')
  })

  it('[TC-KG1I] leaves evidence untouched when every citation is grounded', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        evidence: 'strong' as const,
        data: {
          answer: 'The schema lives in `reversal.ts`.',
          results: [factItem('packages/common/reversal.ts', 'ReversalSchema')],
          retrieval: {},
        },
      },
      { sourceRepos: [] }
    )
    expect(body.evidence).toBe('strong')
  })

  it('[TC-SVF8] notes and downgrades on unsupported prose claims even when the cited file is real', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        evidence: 'strong' as const,
        data: {
          answer:
            'The `FlowsApi.ts` confirms import POSTs the flow to the backend and persists it.',
          results: [factItem('src/FlowsApi.ts', 'FlowsApi')],
          retrieval: {
            unsupportedClaims: ['import POSTs the flow to the backend and persists it'],
          },
        },
      },
      { sourceRepos: [] }
    )
    // The file name is grounded, so the file-name check stays silent — but the claim check fires.
    expect(body.evidence).toBe('weak')
    const claimNote = (body.notes ?? []).find(n => n.includes('do not directly support'))
    expect(claimNote).toBeDefined()
    expect(claimNote).toContain('POSTs the flow to the backend')
    expect(claimNote).toContain('verify against the sources')
  })

  it('[TC-QS05] surfaces unsupportedClaims on the full REST retrieval body', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        evidence: 'strong' as const,
        data: {
          answer: 'Import persists to the backend.',
          results: [factItem('src/FlowsApi.ts', 'FlowsApi')],
          retrieval: { method: 'hybrid', unsupportedClaims: ['Import persists to the backend'] },
        },
      },
      { sourceRepos: [] }
    )
    expect(body.retrieval.unsupportedClaims).toEqual(['Import persists to the backend'])
  })
})

describe('findUngroundedFileReferences', () => {
  it('[TC-LB44] matches by basename so relative prose paths ground against absolute evidence paths', () => {
    const refs = findUngroundedFileReferences(
      'Resolution happens in `src/cli/base-selection.ts`.',
      ['packages/kb-client/src/cli/base-selection.ts']
    )
    expect(refs).toEqual([])
  })

  it('[TC-1NET] ignores non-file tokens: product names, property access, bare words', () => {
    const refs = findUngroundedFileReferences(
      'Node.js reads data.results and config.activeBase, e.g. at startup.',
      []
    )
    expect(refs).toEqual([])
  })

  it('[TC-L52G] reports each ungrounded file once', () => {
    const refs = findUngroundedFileReferences('`dto.ts` … see dto.ts and `other.py`.', [
      'src/real.ts',
    ])
    expect(refs).toEqual(['dto.ts', 'other.py'])
  })

  it('[TC-SVF8] flags a path-qualified citation whose directory does not match, even when the basename does', () => {
    const refs = findUngroundedFileReferences('The type lives in `src/dto.ts`.', ['lib/dto.ts'])
    expect(refs).toEqual(['src/dto.ts'])
  })

  it('[TC-QS05] grounds a path-qualified citation that matches a source path suffix', () => {
    const refs = findUngroundedFileReferences('The type lives in `src/dto.ts`.', [
      'packages/common/src/dto.ts',
    ])
    expect(refs).toEqual([])
  })

  it('[TC-Q6XO] still grounds a bare filename (no path) by basename alone', () => {
    const refs = findUngroundedFileReferences('The type lives in `dto.ts`.', [
      'packages/common/src/dto.ts',
    ])
    expect(refs).toEqual([])
  })
})

describe('empty-base explanation on the wire', () => {
  it('[TC-E233] surfaces IntentResult.explanation and recommendedAction as notes for agents', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'uncertain',
        evidence: 'none',
        explanation: 'This base ("default") is empty — no repositories have been indexed yet.',
        recommendedAction:
          'An operator can add one on the server: `kb-server base add-repo --base default --git <url>`.',
      },
      { sourceRepos: [] }
    )
    expect(body.answer).toBeNull()
    expect(body.evidence).toBe('none')
    expect(body.notes).toEqual([
      'Retrieval evidence was none — verify the cited sources before relying on this answer.',
      'This base ("default") is empty — no repositories have been indexed yet.',
      'An operator can add one on the server: `kb-server base add-repo --base default --git <url>`.',
    ])
  })

  it('[TC-NS33] notes the served base when no sources return (wrong-base / bare-vs-eval visibility)', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'uncertain',
        evidence: 'none',
        data: { results: [] },
      },
      { sourceRepos: [], base: 'raylib' }
    )
    expect(body.notes?.some(n => n.includes('No sources from base "raylib"'))).toBe(true)
    expect(body.notes?.some(n => n.includes('eval-raylib'))).toBe(true)
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

  it('[TC-H88X] Given synthesis failed, then the REST body carries answerError alongside the sources', () => {
    const body = serializeQueryResult(resultWithFailure, { sourceRepos: [] })
    expect(body.answer).toBeNull()
    expect(body.answerError).toEqual(failure)
    // Retrieval succeeded, so the caller still gets something actionable.
    expect(body.results).toHaveLength(1)
  })

  it('[TC-86UB] Given synthesis failed, then the MCP note names the outage instead of blaming the evidence', () => {
    const body = serializeMcpQueryResult(resultWithFailure, { sourceRepos: [] })
    expect(body.answer).toBeNull()
    expect(body.answerError).toEqual(failure)
    const notes = body.notes ?? []
    // The failure leads: an agent reading "open the cited sources directly" would wrongly
    // conclude the KB is thin and stop retrying.
    expect(notes[0]).toContain('insufficient_credits')
    expect(notes[0]).toContain('billing')
    expect(notes.join(' ')).not.toContain('No synthesized answer was produced')
  })

  it('[TC-EKVK] Given a degraded best-effort stage, then the payload says ranking is weaker than usual', () => {
    const body = serializeMcpQueryResult(
      {
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
      },
      { sourceRepos: [] }
    )
    expect(body.answer).toBe('An answer.')
    expect((body.notes ?? []).join(' ')).toContain('curation (rate_limit)')
  })

  it('[TC-10E6] Given no answer and no failure, then the original evidence note is unchanged', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          retrieval: { method: 'facts-loop' },
          results: [{ metadata: { id: 'f1', title: 'Auth', sourcePath: 'src/a.ts' } }],
        },
      },
      { sourceRepos: [] }
    )
    expect(body.notes).toEqual([
      'No synthesized answer was produced — open the cited sources directly.',
    ])
    expect(body.answerError).toBeUndefined()
  })
})

describe('query entities on the wire', () => {
  const entities = [
    { kind: 'api' as const, name: '/v1/query', role: 'scope' as const },
    { kind: 'service' as const, name: 'kb-server', role: 'cited' as const },
  ]

  it('[TC-ENT1] verbose serializer includes entities when present', () => {
    const body = serializeQueryResult(
      {
        status: 'accepted',
        data: {
          answer: 'Query hits /v1/query.',
          results: [factItem('src/http-server.ts')],
          entities,
        },
      },
      { sourceRepos: [] }
    )
    expect(body.entities).toEqual(entities)
  })

  it('[TC-ENT2] lean serializer includes entities and omits the field when empty', () => {
    const withEntities = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: {
          answer: 'Query hits /v1/query.',
          results: [factItem('src/http-server.ts')],
          entities,
        },
      },
      { sourceRepos: [] }
    )
    expect(withEntities.entities).toEqual(entities)
    const empty = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: { answer: 'None.', results: [factItem('src/a.ts')] },
      },
      { sourceRepos: [] }
    )
    expect(empty.entities).toBeUndefined()
  })

  it('[TC-ENT3] lean serializer caps entities at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      kind: 'api' as const,
      name: `/r${i}`,
      role: 'cited' as const,
    }))
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: { answer: 'Many routes.', results: [factItem('src/a.ts')], entities: many },
      },
      { sourceRepos: [] }
    )
    expect(body.entities).toHaveLength(8)
    expect(body.entities?.[0].name).toBe('/r0')
  })

  it('[TC-ENT4] lean sources omit relPath', () => {
    const body = serializeMcpQueryResult(
      {
        status: 'accepted',
        data: { answer: 'Login.', results: [factItem('src/auth/login.ts', 'loginHandler')] },
      },
      { sourceRepos: [] }
    )
    expect(body.sources[0]).toEqual({ path: 'src/auth/login.ts', symbols: ['loginHandler'] })
    expect(body.sources[0]).not.toHaveProperty('relPath')
  })
})
