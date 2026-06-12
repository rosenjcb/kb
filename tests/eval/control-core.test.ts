import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { conditionOf } from '../../scripts/eval-shared.mjs'
import { readQueryResultFile } from '../../scripts/eval-score.mjs'
import {
  assertControlAgentAvailable,
  buildControlComparison,
  controlAgentBinary,
  defaultClaudeArgv,
  describeAgentCommand,
  extractJsonObject,
  runControlPass,
} from '../../scripts/control-core.mjs'

// A fake agent command: ignores stdin, prints a fixed result JSON to stdout. Lets us
// exercise runControlPass end-to-end with no network and no `claude` binary.
const FAKE_AGENT_CMD =
  'printf \'{"result":"Stub answer grounded in src/main.c.","total_cost_usd":0.02,"input_tokens":120,"output_tokens":40,"num_turns":3}\''

function fakeSuite() {
  return {
    id: 'fake',
    questions: ['What does this repo do?', 'How is it built?'],
    answers: null,
    rubricPhrase: 'the fake repo',
    sourceFile: '/tmp/fake.yaml',
    repoUrl: null,
  }
}

describe('control agent command', () => {
  it('default Claude Code argv loads no kb/MCP (--strict-mcp-config)', () => {
    const argv = defaultClaudeArgv({ model: 'claude-opus-4-8', maxTurns: 30 })
    expect(argv).not.toContain('--bare')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--output-format')
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-8']))
    expect(argv).toEqual(expect.arrayContaining(['--max-turns', '30']))
    expect(argv).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit,Write']))
  })

  it('describeAgentCommand prefers an explicit agent-cmd override', () => {
    const custom = 'cursor-agent -p --output-format json'
    expect(describeAgentCommand({ agentCmd: custom })).toBe(custom)
    expect(describeAgentCommand({ agentCmd: null, model: null, maxTurns: 30 })).toContain(
      'claude -p'
    )
  })
})

describe('assertControlAgentAvailable (preflight)', () => {
  it('resolves the agent binary (claude by default, else first token of agent-cmd)', () => {
    expect(controlAgentBinary(null)).toBe('claude')
    expect(controlAgentBinary('cursor-agent -p --output-format json')).toBe('cursor-agent')
  })

  it('throws an actionable error naming the missing binary and --skip-control', () => {
    expect(() =>
      assertControlAgentAvailable({ agentCmd: 'definitely-not-a-real-agent-xyz -p' })
    ).toThrow(/definitely-not-a-real-agent-xyz[\s\S]*--skip-control/)
  })

  it('throws when the control prompt lacks {{question}}', () => {
    // `sh` exists on PATH, so this isolates the prompt-validation failure.
    expect(() =>
      assertControlAgentAvailable({ agentCmd: 'sh', controlPrompt: 'no placeholder' })
    ).toThrow(/question/)
  })

  it('passes for an available binary with a valid prompt', () => {
    expect(() => assertControlAgentAvailable({ agentCmd: 'sh' })).not.toThrow()
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

describe('runControlPass', () => {
  it('runs the agent per question and builds a scored control block', async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'control-pass-'))
    const block = await runControlPass({
      repoDir: workdir,
      workdir,
      suiteConfig: fakeSuite(),
      agentCmd: FAKE_AGENT_CMD,
      autoScore: false, // no judge call → no API key needed
    })
    expect(block.condition).toBe('control')
    expect(block.status).toBe('complete')
    expect(block.agent.name).toBe('custom')
    expect(block.query_evaluation).toHaveLength(2)
    // Telemetry aggregated across both questions.
    expect(block.control_telemetry.total_input_tokens).toBe(240)
    expect(block.control_telemetry.total_output_tokens).toBe(80)
    expect(block.control_telemetry.mean_num_turns).toBe(3)
    // q files written in the control workdir in the __control__ shape.
    const q1 = readQueryResultFile(path.join(workdir, 'q1.json'))
    expect(q1.answer).toContain('Stub answer')
    expect(block.aggregate_scores.query).toBeDefined()
  })

  it('throws when the control prompt lacks the {{question}} placeholder', async () => {
    await expect(
      runControlPass({
        repoDir: tmpdir(),
        workdir: mkdtempSync(path.join(tmpdir(), 'control-bad-')),
        suiteConfig: fakeSuite(),
        agentCmd: FAKE_AGENT_CMD,
        controlPrompt: 'no placeholder here',
        autoScore: false,
      })
    ).rejects.toThrow(/question/)
  })
})

describe('buildControlComparison', () => {
  it('computes kb-minus-control deltas per axis', () => {
    const kbAggregate = {
      query: {
        mean_correctness: 3.8,
        mean_usefulness: 3.5,
        pass_rate_correctness_and_usefulness_at_least_3: 0.75,
      },
    }
    const control = {
      aggregate_scores: {
        query: {
          mean_correctness: 3.0,
          mean_usefulness: 3.0,
          pass_rate_correctness_and_usefulness_at_least_3: 0.5,
        },
      },
      control_telemetry: { total_cost_usd: 0.4 },
    }
    const cmp = buildControlComparison(kbAggregate, control)
    expect(cmp.pass_rate.delta_kb_minus_control).toBe(0.25)
    expect(cmp.mean_correctness.delta_kb_minus_control).toBeCloseTo(0.8)
    expect(cmp.control_efficiency.total_cost_usd).toBe(0.4)
  })
})

describe('readQueryResultFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-read-'))

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
