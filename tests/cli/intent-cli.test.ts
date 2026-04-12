import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import {
  enrichReadDocumentsAnswerWithLLM,
  formatIntentResult,
  isIntentCommand,
  parseIntentCommand,
  executeIntentCommand,
} from '../../src/cli/intent-cli'

describe('intent-cli parsing', () => {
  it('Given submit command, then parses submit_fact envelope', () => {
    const parsed = parseIntentCommand(['submit', 'Deployments need flag X', '--domain', 'ops'])
    expect(parsed.envelope.intent).toBe('submit_fact')
    expect(parsed.envelope.payload.fact).toBe('Deployments need flag X')
    expect(parsed.envelope.payload.domain).toBe('ops')
  })

  it('Given submit with include-session-logs flag, then parses submit payload fields', () => {
    const parsed = parseIntentCommand([
      'submit',
      'Rename canonical identifier.',
      '--include-session-logs',
    ])

    expect(parsed.envelope.payload.includeSessionLogs).toBe(true)
    expect(parsed.envelope.payload.targetDocumentId).toBeUndefined()
  })

  it('Given query with deep discovery option, then parses discoveryDepth in payload', () => {
    const parsed = parseIntentCommand([
      'query',
      'env local strategy',
      '--discovery',
      'deep',
    ])

    expect(parsed.envelope.intent).toBe('query_truth')
    expect(parsed.envelope.payload.discoveryDepth).toBe('deep')
  })

  it('Given dispute without because, then throws validation error', () => {
    expect(() => parseIntentCommand(['dispute', 'Fact only'])).toThrow(
      'dispute requires --because "<counter evidence>"',
    )
  })

  it('Given internal operation name, then is not treated as intent command', () => {
    expect(isIntentCommand('write_document')).toBe(false)
  })

  it('Given json output mode, then formatter returns JSON string', () => {
    const output = formatIntentResult(
      { status: 'valid', explanation: 'ok', confidence: 0.9 },
      'json',
    )
    expect(output).toContain('"status": "valid"')
  })

  it('Given read_documents result in human mode, then formatter returns structured summary with doc locations', () => {
    const output = formatIntentResult(
      {
        status: 'accepted',
        confidence: 0.8,
        explanation: 'query intent maps directly to read_documents',
        recommendedAction: 'read_documents',
        data: {
          answer: 'The KB uses session base first, then default, then KB_BASE fallback.',
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
            checkpoints: [
              {
                stage: 'hybrid_primary',
                status: 'hit',
                nextAction: 'return',
                confidence: 0.86,
              },
            ],
          },
          results: [
            {
              metadata: {
                id: 'cli-facts',
                title: 'CLI Facts',
                filePath: '/tmp/cli-facts.md',
              },
              content: '# CLI Facts\n\nCreated: 2026-04-12\n\n## Base Selection\nKB base precedence order: 1) kb use, 2) kb default, 3) KB_BASE.',
            },
          ],
          total: 1,
        },
      },
      'human',
    )

    expect(output).toContain('Summary: Found 1 matching KB document')
    expect(output).toContain('Answer: The KB uses session base first, then default, then KB_BASE fallback.')
    expect(output).toContain('Answer:')
    expect(output).toContain('Status: accepted')
    expect(output).toContain('Confidence: 0.80')
    expect(output).toContain('Retrieval: hybrid (fts+vector-rerank)')
    expect(output).toContain('Checkpoints: hybrid_primary:hit->return')
    expect(output).toContain('Relevant Docs:')
    expect(output).toContain('location=/tmp/cli-facts.md')
    expect(output).toContain('uri=file:///tmp/cli-facts.md')
    expect(output).toContain('highlights=[base-selection] KB base precedence order')
    expect(output).toContain('Provenance: cli-facts')
    expect(output).toContain('KB base precedence order')
  })

  it('Given read_documents with no results in human mode, then formatter returns structured no-match response', () => {
    const output = formatIntentResult(
      {
        status: 'accepted',
        recommendedAction: 'read_documents',
        data: {
          retrieval: {
            method: 'lexical-fallback',
            detail: 'hybrid-error:no-index',
          },
          results: [],
          total: 0,
        },
      },
      'human',
    )

    expect(output).toContain('Summary: No matching KB documents were found for this query.')
    expect(output).toContain('Answer: I could not find enough evidence to answer directly from KB documents.')
    expect(output).toContain('Retrieval: lexical-fallback (hybrid-error:no-index)')
    expect(output).toContain('Matches: 0')
    expect(output).toContain('Relevant Docs: none')
    expect(output).toContain('Hint: Try a broader phrase')
  })

  it('Given read_documents result and llm provider, then enrichReadDocumentsAnswerWithLLM injects LLM answer', async () => {
    const parsed = parseIntentCommand(['query', 'What is precedence order?'])
    const result = {
      status: 'accepted' as const,
      recommendedAction: 'read_documents',
      data: {
        results: [
          {
            metadata: { id: 'cli-facts', title: 'CLI Facts' },
            content: '# CLI Facts\n\nKB base precedence order: session, default, env fallback.',
          },
        ],
        total: 1,
      },
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'Precedence is session base, then default base, then KB_BASE fallback.',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, provider)
    const data = enriched.data as { answer?: string }
    expect(data.answer).toContain('Precedence is session base')
  })

  it('Given relevant lines later in long content, enrichment should still send matched CLI snippets to LLM', async () => {
    const parsed = parseIntentCommand(['query', 'how do i use kb cli commands'])
    const result = {
      status: 'accepted' as const,
      recommendedAction: 'read_documents',
      data: {
        results: [
          {
            metadata: { id: 'general-facts', title: 'general facts' },
            content: [
              '# general facts',
              '',
              'Created: 2026-04-12',
              'Type: reference',
              'Tags: general, fact',
              '',
              '- SQLite hybrid search enabled for this workspace.',
              '- SQLite index probe write to confirm db creation.',
              '- sqlite probe via refreshed global kb.',
              '- lots of unrelated setup details first.',
              '- more unrelated details.',
              '- even more unrelated details.',
              '- CLI quick-reference: kb --help; kb use dogfood; kb default dogfood; kb submit/query/validate/dispute/explain with --output json; KB_BASE=dogfood kb chat.',
            ].join('\n'),
          },
        ],
        total: 1,
      },
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      call: vi.fn(async ({ messages }) => {
        const content = typeof messages[0]?.content === 'string' ? messages[0].content : ''
        expect(content).toContain('CLI quick-reference: kb --help')
        expect(content).toContain('kb submit/query/validate/dispute/explain')

        return {
          text: 'Use kb --help, then kb query, submit, validate, dispute, explain, or kb chat.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      }),
    }

    const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, provider)
    const data = enriched.data as { answer?: string }
    expect(data.answer).toContain('Use kb --help')
  })

  it('Given matched landing line, enrichment should include nearby context lines in evidence windows', async () => {
    const parsed = parseIntentCommand(['query', 'kb query output json'])
    const result = {
      status: 'accepted' as const,
      recommendedAction: 'read_documents',
      data: {
        results: [
          {
            metadata: { id: 'cli-ref', title: 'CLI Ref' },
            content: [
              '# CLI Ref',
              '',
              'Created: 2026-04-12',
              '',
              'Use kb --help for command discovery.',
              'For direct retrieval use kb query "<topic>" --output json.',
              'Use kb validate "<claim>" --output json for fact validation.',
            ].join('\n'),
          },
        ],
      },
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      call: vi.fn(async ({ messages }) => {
        const content = typeof messages[0]?.content === 'string' ? messages[0].content : ''
        expect(content).toContain('Use kb --help for command discovery.')
        expect(content).toContain('kb query "<topic>" --output json')
        expect(content).toContain('kb validate "<claim>" --output json')

        return {
          text: 'Use kb query with --output json and related intent commands.',
          stopReason: 'end_turn' as const,
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      }),
    }

    await enrichReadDocumentsAnswerWithLLM(parsed, result, provider)
  })

  it('Given LLM insufficiency boilerplate and exact token evidence present, enrichment should replace answer with grounded fallback', async () => {
    const parsed = parseIntentCommand(['query', 'CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION'])
    const result = {
      status: 'accepted' as const,
      recommendedAction: 'read_documents',
      data: {
        results: [
          {
            metadata: { id: 'retrieval-facts', title: 'retrieval facts' },
            content: [
              '# retrieval facts',
              '',
              '- CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION (source: consumer)',
            ].join('\n'),
          },
        ],
        total: 1,
      },
    }

    const provider: LLMProvider = {
      name: 'test-provider',
      supportsStreaming: false,
      call: vi.fn(async () => ({
        text: 'The evidence provided does not contain any information about this token.',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    }

    const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, provider)
    const data = enriched.data as { answer?: string }
    expect(data.answer).toContain('CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION')
    expect(data.answer).toContain('(source: retrieval-facts)')
  })
})

describe('intent-cli execution', () => {
  it('Given parsed query command, then executes through router and returns accepted', async () => {
    const executor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async () => ({ results: [], total: 0 })),
    }

    const parsed = parseIntentCommand(['query', 'auth'])
    const result = await executeIntentCommand(parsed, executor)

    expect(result.status).toBe('accepted')
  })
})
