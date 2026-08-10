import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunReport } from '@kb/core/core/telemetry.js'

function makeReport(overrides: Partial<RunReport> & { command: string }): RunReport {
  const base: RunReport = {
    runId: `run-${Math.random().toString(16).slice(2, 8)}`,
    command: overrides.command,
    startedAt: '2026-04-17T10:00:00.000Z',
    finishedAt: '2026-04-17T10:00:30.000Z',
    totalDurationMs: 30000,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalEstimatedCostUsd: 0.0001,
    stages: [],
    status: 'success',
  }
  return { ...base, ...overrides }
}

function mockLogsDir(reports: RunReport[]): void {
  const ndjson = `${reports.map(r => JSON.stringify(r)).join('\n')}\n`
  vi.doMock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
      ...actual,
      readdir: vi.fn().mockResolvedValue(['2026-04-17.jsonl']),
      readFile: vi.fn().mockResolvedValue(ndjson),
    }
  })
  vi.doMock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: vi.fn().mockReturnValue(true) }
  })
}

beforeEach(() => {
  vi.resetModules()
})

describe('runSessionCommand', () => {
  it('[TC-442] Given no reports carry a sessionId, then returns a friendly notice', async () => {
    mockLogsDir([makeReport({ command: 'init' }), makeReport({ command: 'scan' })])
    const { runSessionCommand } = await import('@kb/core/cli/session-cli.js')
    const output = await runSessionCommand([])
    expect(output).toContain('No chat sessions found')
    vi.resetModules()
  })

  it('[TC-443] Given two sessions, then summarizes the most recent and totals its runs', async () => {
    mockLogsDir([
      makeReport({
        runId: 'run-old',
        command: 'query',
        sessionId: 'sess-old',
        startedAt: '2026-04-17T09:00:00.000Z',
      }),
      makeReport({
        runId: 'run-new-1',
        command: 'chat',
        sessionId: 'sess-new',
        startedAt: '2026-04-17T11:00:00.000Z',
        totalInputTokens: 700,
      }),
      makeReport({
        runId: 'run-new-2',
        command: 'query',
        sessionId: 'sess-new',
        startedAt: '2026-04-17T11:05:00.000Z',
        totalInputTokens: 300,
      }),
    ])
    const { runSessionCommand } = await import('@kb/core/cli/session-cli.js')
    const output = await runSessionCommand([])
    expect(output).toContain('sess-new')
    expect(output).not.toContain('sess-old')
    expect(output).toContain('run-new-1')
    expect(output).toContain('run-new-2')
    expect(output).toContain('Runs:     2')
    expect(output).toContain('in=1000') // 700 + 300
    vi.resetModules()
  })

  it('[TC-444] Given a --session prefix, then selects that session even when older', async () => {
    mockLogsDir([
      makeReport({
        runId: 'run-old',
        command: 'query',
        sessionId: 'sess-old-abc',
        startedAt: '2026-04-17T09:00:00.000Z',
      }),
      makeReport({
        runId: 'run-new',
        command: 'chat',
        sessionId: 'sess-new-xyz',
        startedAt: '2026-04-17T11:00:00.000Z',
      }),
    ])
    const { runSessionCommand } = await import('@kb/core/cli/session-cli.js')
    const output = await runSessionCommand(['--session', 'sess-old'])
    expect(output).toContain('sess-old-abc')
    expect(output).toContain('run-old')
    vi.resetModules()
  })

  it('[TC-445] Given an unknown --session selector, then throws not found', async () => {
    mockLogsDir([
      makeReport({ runId: 'run-a', command: 'chat', sessionId: 'sess-real' }),
    ])
    const { runSessionCommand } = await import('@kb/core/cli/session-cli.js')
    await expect(runSessionCommand(['--session', 'nope'])).rejects.toThrow('Session not found')
    vi.resetModules()
  })
})
