import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dayjs from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReportWriter,
  RunCollector,
  TokenCountingProvider,
  TrajectoryCollector,
  estimateCost,
} from '../../src/core/telemetry'
import type { TrajectoryFile } from '../../src/core/telemetry'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'

// ─── estimateCost ─────────────────────────────────────────────────

describe('estimateCost', () => {
  it('Given gemini-2.0-flash with known tokens, then returns a positive cost', () => {
    const cost = estimateCost('gemini', 'gemini-2.0-flash', 1_000_000, 1_000_000)
    expect(cost).toBeGreaterThan(0)
  })

  it('Given gemini-2.5-pro, then applies higher pricing than gemini-2.0-flash', () => {
    const flash = estimateCost('gemini', 'gemini-2.0-flash', 1_000_000, 1_000_000)
    const pro = estimateCost('gemini', 'gemini-2.5-pro', 1_000_000, 1_000_000)
    expect(pro).toBeGreaterThan(flash)
  })

  it('Given anthropic claude-sonnet-4-6, then returns a positive cost', () => {
    expect(estimateCost('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeGreaterThan(0)
  })

  it('Given openai gpt-4o, then returns a positive cost', () => {
    expect(estimateCost('openai', 'gpt-4o', 100_000, 50_000)).toBeGreaterThan(0)
  })

  it('Given a model not in the pricing table, then returns 0', () => {
    expect(estimateCost('openai', 'gpt-4-turbo', 100_000, 50_000)).toBe(0)
  })

  it('Given ollama provider, then returns 0 (local/free)', () => {
    expect(estimateCost('ollama', 'mistral', 100_000, 50_000)).toBe(0)
  })

  it('Given unknown provider, then returns 0', () => {
    expect(estimateCost('unknown-llm', 'some-model', 100_000, 50_000)).toBe(0)
  })

  it('Given zero tokens, then returns 0', () => {
    expect(estimateCost('gemini', 'gemini-2.0-flash', 0, 0)).toBe(0)
  })
})

// ─── RunCollector ─────────────────────────────────────────────────

describe('RunCollector', () => {
  it('Given a finished collector with no stages, then report totals are all zero', () => {
    const c = new RunCollector('query')
    const report = c.finish('success')
    expect(report.command).toBe('query')
    expect(report.status).toBe('success')
    expect(report.stages).toHaveLength(0)
    expect(report.totalInputTokens).toBe(0)
    expect(report.totalOutputTokens).toBe(0)
    expect(report.totalEstimatedCostUsd).toBe(0)
  })

  it('Given added stages, then totals accumulate correctly', () => {
    const c = new RunCollector('init')
    c.addStage({
      stage: 'pass1',
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      inputTokens: 300,
      outputTokens: 200,
      estimatedCostUsd: 0.00005,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    })
    c.addStage({
      stage: 'pass2',
      startedAt: new Date().toISOString(),
      durationMs: 800,
      inputTokens: 250,
      outputTokens: 150,
      estimatedCostUsd: 0.00004,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    })
    const report = c.finish('success')
    expect(report.totalInputTokens).toBe(550)
    expect(report.totalOutputTokens).toBe(350)
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.00009, 8)
    expect(report.stages).toHaveLength(2)
  })

  it('Given an error finish, then report status and message are set', () => {
    const c = new RunCollector('submit')
    const report = c.finish('error', 'connection refused')
    expect(report.status).toBe('error')
    expect(report.errorMessage).toBe('connection refused')
  })

  it('Given startStage, then calling the returned function records the stage', () => {
    const c = new RunCollector('invalidate')
    const end = c.startStage('invalidate', 'none', 'none')
    end({ inputTokens: 0, outputTokens: 0 })
    const report = c.finish('success')
    expect(report.stages).toHaveLength(1)
    expect(report.stages[0].stage).toBe('invalidate')
    expect(report.stages[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('Given addStage, then does not write to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const c = new RunCollector('query')
    c.addStage({
      stage: 'pass1',
      startedAt: new Date().toISOString(),
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('Given a report, then runId follows expected format', () => {
    const c = new RunCollector('query')
    const report = c.finish('success')
    expect(report.runId).toMatch(/^run-\d+-[a-z0-9]{4}$/)
  })

  it('Given a report, then startedAt and finishedAt are valid ISO strings', () => {
    const c = new RunCollector('query')
    const report = c.finish('success')
    expect(new Date(report.startedAt).getTime()).toBeGreaterThan(0)
    expect(new Date(report.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(report.startedAt).getTime()
    )
  })
})

// ─── TokenCountingProvider ────────────────────────────────────────

function makeFakeProvider(inputTokens: number, outputTokens: number): LLMProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    supportsStreaming: false,
    async call(_params: LLMCallParams): Promise<LLMResponse> {
      return {
        text: 'ok',
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens, outputTokens },
      }
    },
  }
}

describe('TokenCountingProvider', () => {
  it('Given a single call, then peek returns the token counts', async () => {
    const counter = new TokenCountingProvider(makeFakeProvider(400, 200))
    await counter.call({ messages: [{ role: 'user', content: 'hi' }] })
    expect(counter.peek()).toEqual({ inputTokens: 400, outputTokens: 200 })
  })

  it('Given multiple calls, then peek accumulates across all calls', async () => {
    const inner = {
      name: 'fake',
      model: 'fake-model',
      supportsStreaming: false,
      async call(_p: LLMCallParams): Promise<LLMResponse> {
        return {
          text: '',
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: 100, outputTokens: 50 },
        }
      },
    }
    const counter = new TokenCountingProvider(inner)
    await counter.call({ messages: [{ role: 'user', content: 'a' }] })
    await counter.call({ messages: [{ role: 'user', content: 'b' }] })
    await counter.call({ messages: [{ role: 'user', content: 'c' }] })
    expect(counter.peek()).toEqual({ inputTokens: 300, outputTokens: 150 })
  })

  it('Given getAndReset, then returns accumulated totals and resets to zero', async () => {
    const counter = new TokenCountingProvider(makeFakeProvider(500, 100))
    await counter.call({ messages: [{ role: 'user', content: 'x' }] })
    const first = counter.getAndReset()
    expect(first).toEqual({ inputTokens: 500, outputTokens: 100 })
    expect(counter.peek()).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('Given getAndReset called twice, then second call returns zeros', async () => {
    const counter = new TokenCountingProvider(makeFakeProvider(300, 150))
    await counter.call({ messages: [{ role: 'user', content: 'x' }] })
    counter.getAndReset()
    expect(counter.getAndReset()).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('Given two cycles using getAndReset between them, then each cycle is counted independently', async () => {
    let callCount = 0
    const inner = {
      name: 'fake',
      model: 'fake-model',
      supportsStreaming: false,
      async call(_p: LLMCallParams): Promise<LLMResponse> {
        callCount++
        const tokens = callCount <= 2 ? 100 : 200
        return {
          text: '',
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: tokens, outputTokens: tokens },
        }
      },
    }
    const counter = new TokenCountingProvider(inner)
    await counter.call({ messages: [] })
    await counter.call({ messages: [] })
    const cycle1 = counter.getAndReset()
    await counter.call({ messages: [] })
    await counter.call({ messages: [] })
    const cycle2 = counter.getAndReset()

    expect(cycle1).toEqual({ inputTokens: 200, outputTokens: 200 })
    expect(cycle2).toEqual({ inputTokens: 400, outputTokens: 400 })
  })

  it('Given delegated call, then response is passed through unmodified', async () => {
    const expected: LLMResponse = {
      text: 'hello world',
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens: 5, outputTokens: 3 },
    }
    const inner = {
      name: 'fake',
      model: 'fake-model',
      supportsStreaming: false,
      async call(_p: LLMCallParams) {
        return expected
      },
    }
    const counter = new TokenCountingProvider(inner)
    const result = await counter.call({ messages: [] })
    expect(result).toEqual(expected)
  })

  it('Given name/model/supportsStreaming, then delegates to inner provider', () => {
    const inner = makeFakeProvider(0, 0)
    const counter = new TokenCountingProvider(inner)
    expect(counter.name).toBe('fake')
    expect(counter.model).toBe('fake-model')
    expect(counter.supportsStreaming).toBe(false)
  })
})

// ─── ReportWriter ─────────────────────────────────────────────────

describe('ReportWriter', () => {
  it('Given a report, then appends NDJSON to the correct dated file', async () => {
    const logsDir = await mkdtemp(path.join(os.tmpdir(), 'kb-logs-test-'))
    const writer = new ReportWriter(logsDir)
    const c = new RunCollector('query')
    c.addStage({
      stage: 'query_truth:iter1',
      startedAt: new Date().toISOString(),
      durationMs: 70,
      inputTokens: 100,
      outputTokens: 5,
      estimatedCostUsd: 0.00001,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    })
    const report = c.finish('success')
    await writer.append(report)

    const today = dayjs().format('YYYY-MM-DD')
    const filePath = path.join(logsDir, `${today}.jsonl`)
    expect(existsSync(filePath)).toBe(true)
    const contents = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(contents.trim())
    expect(parsed.command).toBe('query')
    expect(parsed.status).toBe('success')
    expect(parsed.stages).toHaveLength(1)
    expect(parsed.stages[0].stage).toBe('query_truth:iter1')
  })

  it('Given two appends, then both reports appear as separate NDJSON lines', async () => {
    const logsDir = await mkdtemp(path.join(os.tmpdir(), 'kb-logs-test-'))
    const writer = new ReportWriter(logsDir)
    await writer.append(new RunCollector('query').finish('success'))
    await writer.append(new RunCollector('submit').finish('success'))

    const today = dayjs().format('YYYY-MM-DD')
    const contents = await readFile(path.join(logsDir, `${today}.jsonl`), 'utf-8')
    const lines = contents.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).command).toBe('query')
    expect(JSON.parse(lines[1]).command).toBe('submit')
  })

  it('Given a bad logs dir path, then append does not throw and warns on stderr', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Use a path under a non-existent root that mkdir cannot create
    const writer = new ReportWriter('/dev/null/cannot-exist/logs')
    const c = new RunCollector('query')
    await expect(writer.append(c.finish('success'))).resolves.not.toThrow()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('could not write run report'))
    stderrSpy.mockRestore()
  })
})

// ─── TrajectoryCollector ──────────────────────────────────────────

describe('TrajectoryCollector', () => {
  it('Given a fresh collector, compileTrajectory returns empty steps and non-negative elapsedMs', () => {
    const c = new TrajectoryCollector('task-1', 'K')
    const t = c.compileTrajectory()
    expect(t.totalSteps).toBe(0)
    expect(t.steps).toHaveLength(0)
    expect(t.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(t.taskId).toBe('task-1')
    expect(t.condition).toBe('K')
  })

  it('Given a single step, stepIndex is 0 and fields match what was passed', () => {
    const c = new TrajectoryCollector('task-2', 'N')
    c.record_step('read_file', { path: '/src/foo.ts' }, { fresh: 100, cached: 50, output: 20 })
    const t = c.compileTrajectory()
    expect(t.totalSteps).toBe(1)
    expect(t.steps[0].stepIndex).toBe(0)
    expect(t.steps[0].toolName).toBe('read_file')
    expect(t.steps[0].arguments).toEqual({ path: '/src/foo.ts' })
    expect(t.steps[0].freshTokens).toBe(100)
    expect(t.steps[0].cachedTokens).toBe(50)
    expect(t.steps[0].outputTokens).toBe(20)
    expect(t.steps[0].timestampMs).toBeGreaterThanOrEqual(0)
  })

  it('Given duplicate tool calls, both appear with sequential stepIndex values', () => {
    const c = new TrajectoryCollector('task-3', 'O')
    c.record_step('read_facts', { id: 'fact-1' })
    c.record_step('read_facts', { id: 'fact-1' })
    const t = c.compileTrajectory()
    expect(t.totalSteps).toBe(2)
    expect(t.steps[0].stepIndex).toBe(0)
    expect(t.steps[1].stepIndex).toBe(1)
    expect(t.steps[0].toolName).toBe('read_facts')
    expect(t.steps[1].toolName).toBe('read_facts')
  })

  it('Given no tokens argument, all token fields default to 0', () => {
    const c = new TrajectoryCollector('task-4', 'K')
    c.record_step('search_code', { query: 'foo' })
    const step = c.compileTrajectory().steps[0]
    expect(step.freshTokens).toBe(0)
    expect(step.cachedTokens).toBe(0)
    expect(step.outputTokens).toBe(0)
  })

  it('Given compiled trajectory, JSON round-trip produces identical result', () => {
    const c = new TrajectoryCollector('task-5', 'N')
    c.record_step('tool_a', { x: 1 }, { fresh: 10 })
    c.record_step('tool_b', { y: 'hello' })
    const t = c.compileTrajectory()
    const roundTripped: TrajectoryFile = JSON.parse(JSON.stringify(t))
    expect(roundTripped).toEqual(t)
  })

  it('Given writeTrajectory, file is written at expected path and parses back correctly', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-traj-test-'))
    try {
      const c = new TrajectoryCollector('task-6', 'K')
      c.record_step('read_facts', { id: 'fact-abc' }, { fresh: 200, output: 10 })
      await c.writeTrajectory(tmpDir)
      const filePath = path.join(tmpDir, 'trajectory_K.json')
      expect(existsSync(filePath)).toBe(true)
      const parsed: TrajectoryFile = JSON.parse(await readFile(filePath, 'utf-8'))
      expect(parsed.taskId).toBe('task-6')
      expect(parsed.condition).toBe('K')
      expect(parsed.totalSteps).toBe(1)
      expect(parsed.steps[0].toolName).toBe('read_facts')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
