import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dayjs from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReportWriter,
  RunCollector,
  TokenCountingProvider,
  estimateCost,
} from '../../src/core/telemetry'
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

  it('Given debug mode, then addStage writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const c = new RunCollector('query', { debug: true })
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
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[kb:debug]'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('query_truth:iter1'))
    spy.mockRestore()
  })

  it('Given debug mode, then finish writes totals summary to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const c = new RunCollector('init', { debug: true })
    c.finish('success')
    const calls = spy.mock.calls.map(c => c[0] as string)
    expect(calls.some(s => s.includes('Total:'))).toBe(true)
    spy.mockRestore()
  })

  it('Given no debug mode, then addStage does not write to stderr', () => {
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
