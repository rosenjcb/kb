import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../../src/core/tool-registry'
import {
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
    expect(output).toContain('Status: accepted')
    expect(output).toContain('Confidence: 0.80')
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
          results: [],
          total: 0,
        },
      },
      'human',
    )

    expect(output).toContain('Summary: No matching KB documents were found for this query.')
    expect(output).toContain('Matches: 0')
    expect(output).toContain('Relevant Docs: none')
    expect(output).toContain('Hint: Try a broader phrase')
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
