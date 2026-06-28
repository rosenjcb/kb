import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { conditionOf } from '../../scripts/eval-shared.mjs'
import { readQueryResultFile } from '../../scripts/eval-score.mjs'
import {
  assertControlAgentAvailable,
  buildControlComparison,
  controlAgentBinary,
  defaultClaudeArgv,
  defaultCursorArgv,
  describeAgentCommand,
  extractJsonObject,
  formatControlAnswerLog,
  normalizeAgentTelemetry,
  normalizeControlAgent,
  runControlPass,
} from '../../scripts/control-core.mjs'

// Cross-platform stub: avoid shell `printf` differences (dash/busybox/CI).
const FAKE_AGENT_CMD =
  'node -e "process.stdout.write(JSON.stringify({result:\'Stub answer grounded in src/main.c.\',total_cost_usd:0.02,input_tokens:120,output_tokens:40,num_turns:3}))"'

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
  it('[TC-13] default Claude Code argv loads no kb/MCP (--strict-mcp-config)', () => {
    const argv = defaultClaudeArgv({ model: 'claude-opus-4-8', maxTurns: 30 })
    expect(argv).not.toContain('--bare')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--output-format')
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-8']))
    expect(argv).toEqual(expect.arrayContaining(['--max-turns', '30']))
    expect(argv).toEqual(expect.arrayContaining(['--disallowedTools', 'Edit,Write']))
  })

  it('[TC-14] describeAgentCommand prefers an explicit agent-cmd override', () => {
    const custom = 'my-agent -p --output-format json'
    expect(describeAgentCommand({ agentCmd: custom })).toBe(custom)
    expect(describeAgentCommand({ agentCmd: null, model: null, maxTurns: 30 })).toContain(
      'claude -p'
    )
    expect(describeAgentCommand({ controlAgent: 'cursor', model: 'composer-2.5' })).toBe(
      'agent -p --output-format json --mode ask --trust --model composer-2.5'
    )
  })

  it('[TC-15] defaultCursorArgv uses read-only ask mode with json output', () => {
    const argv = defaultCursorArgv({ model: 'composer-2.5' })
    expect(argv).toContain('-p')
    expect(argv).toContain('--mode')
    expect(argv).toContain('ask')
    expect(argv).toContain('--trust')
    expect(argv).toEqual(expect.arrayContaining(['--model', 'composer-2.5']))
  })
})

describe('normalizeControlAgent', () => {
  it('[TC-16] accepts claude and cursor', () => {
    expect(normalizeControlAgent('claude')).toBe('claude')
    expect(normalizeControlAgent('Cursor')).toBe('cursor')
  })
  it('[TC-17] throws on unknown backends', () => {
    expect(() => normalizeControlAgent('gpt')).toThrow(/claude, cursor/)
  })
})

describe('assertControlAgentAvailable (preflight)', () => {
  it('[TC-18] resolves the agent binary (claude by default, cursor → agent, else agent-cmd)', () => {
    expect(controlAgentBinary()).toBe('claude')
    expect(controlAgentBinary({ controlAgent: 'cursor' })).toBe('agent')
    expect(controlAgentBinary({ agentCmd: 'my-agent -p --output-format json' })).toBe('my-agent')
  })

  it('[TC-19] throws an actionable error naming the missing binary and --skip-control', () => {
    expect(() =>
      assertControlAgentAvailable({ agentCmd: 'definitely-not-a-real-agent-xyz -p' })
    ).toThrow(/definitely-not-a-real-agent-xyz[\s\S]*--skip-control/)
  })

  it('[TC-20] throws when the control prompt lacks {{question}}', () => {
    // `sh` exists on PATH, so this isolates the prompt-validation failure.
    expect(() =>
      assertControlAgentAvailable({ agentCmd: 'sh', controlPrompt: 'no placeholder' })
    ).toThrow(/question/)
  })

  it('[TC-21] passes for an available binary with a valid prompt', () => {
    expect(() => assertControlAgentAvailable({ agentCmd: 'sh' })).not.toThrow()
  })
})

describe('formatControlAnswerLog', () => {
  it('[TC-22] shows tokens and duration for Cursor-style telemetry', () => {
    const line = formatControlAnswerLog({
      input_tokens: 34001,
      output_tokens: 3613,
      cache_read_tokens: 182354,
      duration_ms: 60613,
    })
    expect(line).toContain('in=34001 out=3613')
    expect(line).toContain('cache=182354')
    expect(line).toContain('61s')
    expect(line).not.toContain('turns=')
    expect(line).not.toContain('cost=')
  })

  it('[TC-23] shows turns and cost for Claude-style telemetry', () => {
    const line = formatControlAnswerLog({
      input_tokens: 120,
      output_tokens: 40,
      num_turns: 3,
      total_cost_usd: 0.02,
      duration_ms: 4500,
    })
    expect(line).toContain('in=120 out=40')
    expect(line).toContain('turns=3')
    expect(line).toContain('cost=$0.0200')
    expect(line).toContain('4.5s')
  })
})

describe('normalizeAgentTelemetry', () => {
  it('[TC-24] reads Cursor Agent CLI camelCase usage fields', () => {
    const tel = normalizeAgentTelemetry({
      result: 'ok',
      duration_ms: 1200,
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 },
    })
    expect(tel.input_tokens).toBe(100)
    expect(tel.output_tokens).toBe(40)
    expect(tel.cache_read_tokens).toBe(10)
    expect(tel.duration_ms).toBe(1200)
  })
})

describe('extractJsonObject', () => {
  it('[TC-25] parses the trailing JSON object even with a leading banner', () => {
    const stdout = 'some banner noise\n{"result":"hello","total_cost_usd":0.12}'
    expect(extractJsonObject(stdout)).toEqual({ result: 'hello', total_cost_usd: 0.12 })
  })
  it('[TC-26] throws when there is no JSON object', () => {
    expect(() => extractJsonObject('no json here')).toThrow()
  })
})

describe('runControlPass', () => {
  it('[TC-27] runs the agent per question and builds a scored control block', async () => {
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
    // Composite success score is computed from the control's own telemetry.
    expect(typeof block.aggregate_scores.query.success_score).toBe('number')
    expect(block.aggregate_scores.query.token_efficiency).not.toBeNull()
    expect(block.aggregate_scores.query.speed_score).not.toBeNull()
  })

  it('[TC-28] returns partial when the agent fails on some questions', async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'control-partial-'))
    const block = await runControlPass({
      repoDir: workdir,
      workdir,
      suiteConfig: fakeSuite(),
      agentCmd: 'node -e "process.exit(1)"',
      autoScore: false,
    })
    expect(block.status).toBe('partial')
    expect(block.query_evaluation.every(ev => ev.answer_excerpt === null)).toBe(true)
  })

  it('[TC-29] throws when the control prompt lacks the {{question}} placeholder', async () => {
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

  it('[TC-30] returns complete_unscored when agent answers succeed but auto-score throws', async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'control-unscored-'))
    // Patch runAutoScoreFile to simulate a Gemini fetch failure.
    const evalScore = await import('../../scripts/eval-score.mjs')
    const spy = vi.spyOn(evalScore, 'runAutoScoreFile').mockRejectedValueOnce(new Error('fetch failed'))
    try {
      const block = await runControlPass({
        repoDir: workdir,
        workdir,
        suiteConfig: fakeSuite(),
        agentCmd: FAKE_AGENT_CMD,
        autoScore: true,
      })
      // Answers must be preserved.
      expect(block.condition).toBe('control')
      expect(block.status).toBe('complete_unscored')
      expect(block.query_evaluation).toHaveLength(2)
      expect(block.query_evaluation[0].answer_excerpt).toBeTruthy()
      // Scores default to zero when judge failed.
      expect(block.query_evaluation[0].scores.correctness).toBe(0)
      // Scoring failure surfaced in metadata.
      expect(block.query_scoring?.mode).toBe('failed')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('buildControlComparison', () => {
  it('[TC-31] computes kb-minus-control deltas per axis', () => {
    const kbAggregate = {
      query: {
        success_score: 0.78,
        mean_correctness: 3.8,
        mean_usefulness: 3.5,
        pass_rate_correctness_and_usefulness_at_least_3: 0.75,
      },
    }
    const control = {
      aggregate_scores: {
        query: {
          success_score: 0.74,
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
    expect(cmp.success_score.delta_kb_minus_control).toBeCloseTo(0.04)
    expect(cmp.control_efficiency.total_cost_usd).toBe(0.4)
  })
})

describe('readQueryResultFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-read-'))

  it('[TC-32] reads a control JSON result (the __control__ sentinel)', () => {
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

  it('[TC-33] falls back to kb-query text parsing for non-control files', () => {
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
  it('[TC-34] tags control vs kb artifacts', () => {
    expect(conditionOf({ run: { condition: 'control' } })).toBe('control')
    expect(conditionOf({ run: { condition: 'kb' } })).toBe('kb')
    expect(conditionOf({ run: { mode: 'control_agent' } })).toBe('control')
    expect(conditionOf({ run: {} })).toBeNull()
  })
})
