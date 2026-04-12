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
