import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { conditionOf } from '../../scripts/eval-shared.mjs'
import { readQueryResultFile } from '../../scripts/eval-score.mjs'
import {
  defaultClaudeArgv,
  describeAgentCommand,
  extractJsonObject,
  parseArgs,
} from '../../scripts/control-run.mjs'

describe('control agent command', () => {
  it('default Claude Code argv loads no kb/MCP (--bare, --strict-mcp-config)', () => {
    const argv = defaultClaudeArgv({ model: 'claude-opus-4-8', maxTurns: 30 })
    expect(argv).toContain('--bare')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--output-format')
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-8']))
    expect(argv).toEqual(expect.arrayContaining(['--max-turns', '30']))
    // Read-only exploration: no Edit/Write.
    expect(argv).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit,Write']))
  })

  it('describeAgentCommand prefers an explicit --agent-cmd override', () => {
    const custom = 'cursor-agent -p --output-format json'
    expect(describeAgentCommand({ agentCmd: custom })).toBe(custom)
    expect(describeAgentCommand({ agentCmd: null, model: null, maxTurns: 30 })).toContain(
      'claude -p'
    )
  })
})

describe('extractJsonObject', () => {
  it('parses the trailing JSON object even with a leading banner', () => {
    const stdout = 'some banner noise\n{"result":"hello","total_cost_usd":0.12}'
    expect(extractJsonObject(stdout)).toEqual({ result: 'hello', total_cost_usd: 0.12 })
  })
  it('throws when there is no JSON object', () => {
    expect(() => extractJsonObject('no json here')).toThrow()
  })
})

describe('parseArgs (control)', () => {
  it('defaults to auto-score on and the {{question}} prompt template', () => {
    const a = parseArgs(['node', 'control-run.mjs', '--suite', 'raylib'])
    expect(a.suite).toBe('raylib')
    expect(a.autoScore).toBe(true)
    expect(a.controlPrompt).toContain('{{question}}')
  })
  it('--manual-score disables auto scoring; --agent-cmd is captured', () => {
    const a = parseArgs([
      'node',
      'control-run.mjs',
      '--suite',
      'raylib',
      '--manual-score',
      '--agent-cmd',
      'cursor-agent -p',
    ])
    expect(a.autoScore).toBe(false)
    expect(a.agentCmd).toBe('cursor-agent -p')
  })
})

describe('readQueryResultFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-test-'))

  it('reads a control JSON result (the __control__ sentinel)', () => {
    const f = path.join(dir, 'q1.json')
    writeFileSync(
      f,
      JSON.stringify({
        __control__: true,
        answer: 'control answer',
        result_count: 0,
        provenance: [],
        retrieval: { method: 'control-agent', detail: 'claude-code', confidence: null },
        telemetry: { input_tokens: 100, output_tokens: 50, num_turns: 4 },
      })
    )
    const r = readQueryResultFile(f)
    expect(r.answer).toBe('control answer')
    expect(r.telemetry?.num_turns).toBe(4)
  })

  it('falls back to kb-query text parsing for non-control files', () => {
    const f = path.join(dir, 'q2.json')
    writeFileSync(
      f,
      ['🤖 KB Agent', 'stage> answer', 'KB textual answer.', '---', 'matches> 7 ranked facts'].join(
        '\n'
      )
    )
    const r = readQueryResultFile(f)
    expect(r.answer).toBe('KB textual answer.')
    expect(r.result_count).toBe(7)
  })
})

describe('conditionOf', () => {
  it('tags control vs kb artifacts', () => {
    expect(conditionOf({ run: { condition: 'control' } })).toBe('control')
    expect(conditionOf({ run: { condition: 'kb' } })).toBe('kb')
    expect(conditionOf({ run: { mode: 'control_agent' } })).toBe('control')
    expect(conditionOf({ run: {} })).toBeNull()
  })
})
