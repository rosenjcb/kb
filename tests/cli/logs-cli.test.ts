import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runLogsCommand, printLogsHelp } from '../../src/cli/logs-cli'
import type { RunReport } from '../../src/core/telemetry'

// ─── Fixtures ─────────────────────────────────────────────────────

function makeReport(overrides: Partial<RunReport> & { command: string }): RunReport {
  const base: RunReport = {
    runId: `run-${Date.now()}-abcd`,
    command: overrides.command,
    startedAt: overrides.startedAt ?? '2026-04-17T10:00:00.000Z',
    finishedAt: overrides.finishedAt ?? '2026-04-17T10:00:30.000Z',
    totalDurationMs: overrides.totalDurationMs ?? 30000,
    totalInputTokens: overrides.totalInputTokens ?? 1000,
    totalOutputTokens: overrides.totalOutputTokens ?? 500,
    totalEstimatedCostUsd: overrides.totalEstimatedCostUsd ?? 0.0001,
    stages: overrides.stages ?? [],
    status: overrides.status ?? 'success',
  }
  return { ...base, ...overrides }
}

const initReportA = makeReport({
  runId: 'run-100-aaaa',
  command: 'init',
  startedAt: '2026-04-17T09:00:00.000Z',
  totalDurationMs: 30000,
  totalInputTokens: 2000,
  totalOutputTokens: 900,
  totalEstimatedCostUsd: 0.00044,
  stages: [
    { stage: 'pass1', startedAt: '2026-04-17T09:00:00.000Z', durationMs: 7000, inputTokens: 300, outputTokens: 200, estimatedCostUsd: 0.00009, provider: 'gemini', model: 'gemini-2.0-flash' },
    { stage: 'pass2', startedAt: '2026-04-17T09:00:07.000Z', durationMs: 5000, inputTokens: 250, outputTokens: 150, estimatedCostUsd: 0.00007, provider: 'gemini', model: 'gemini-2.0-flash' },
  ],
})

const initReportB = makeReport({
  runId: 'run-200-bbbb',
  command: 'init',
  startedAt: '2026-04-17T09:05:00.000Z',
  totalDurationMs: 25000,
  totalInputTokens: 1800,
  totalOutputTokens: 850,
  totalEstimatedCostUsd: 0.00038,
  stages: [
    { stage: 'pass1', startedAt: '2026-04-17T09:05:00.000Z', durationMs: 6000, inputTokens: 280, outputTokens: 190, estimatedCostUsd: 0.00008, provider: 'gemini', model: 'gemini-2.0-flash' },
    { stage: 'pass2', startedAt: '2026-04-17T09:05:06.000Z', durationMs: 4500, inputTokens: 240, outputTokens: 140, estimatedCostUsd: 0.00006, provider: 'gemini', model: 'gemini-2.0-flash' },
  ],
})

const queryReport = makeReport({
  runId: 'run-300-cccc',
  command: 'query',
  startedAt: '2026-04-17T09:10:00.000Z',
  totalDurationMs: 1600,
  totalInputTokens: 1500,
  totalOutputTokens: 5,
  totalEstimatedCostUsd: 0.00012,
})

// ─── Mock filesystem ──────────────────────────────────────────────

function mockLogsDir(reports: RunReport[]) {
  const ndjson = reports.map(r => JSON.stringify(r)).join('\n') + '\n'
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
      ...actual,
      readdir: vi.fn().mockResolvedValue(['2026-04-17.jsonl']),
      readFile: vi.fn().mockResolvedValue(ndjson),
    }
  })
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: vi.fn().mockReturnValue(true) }
  })
}

beforeEach(() => {
  vi.resetModules()
})

// ─── printLogsHelp ────────────────────────────────────────────────

describe('printLogsHelp', () => {
  it('includes all three subcommands', () => {
    const help = printLogsHelp()
    expect(help).toContain('kb logs list')
    expect(help).toContain('kb logs show')
    expect(help).toContain('kb logs compare')
  })

  it('documents --since flag', () => {
    expect(printLogsHelp()).toContain('--since')
  })
})

// ─── kb logs list ─────────────────────────────────────────────────

describe('runLogsCommand list', () => {
  it('Given no reports, then returns empty message', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) }
    })
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['list'])
    expect(output).toContain('No run reports found')
    vi.resetModules()
  })

  it('Given reports, then list includes run ID, command, and duration', async () => {
    mockLogsDir([initReportA, queryReport])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['list'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('init')
    expect(output).toContain('run-300-cccc')
    expect(output).toContain('query')
    vi.resetModules()
  })

  it('Given --command filter, then only matching command appears', async () => {
    mockLogsDir([initReportA, queryReport])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['list', '--command', 'query'])
    expect(output).toContain('run-300-cccc')
    expect(output).not.toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('Given --limit 1, then only one row appears', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['list', '--limit', '1'])
    // Most recent first, so queryReport (last) should appear
    const runIdMatches = (output.match(/run-\d+-[a-z]+/g) ?? [])
    expect(runIdMatches).toHaveLength(1)
    vi.resetModules()
  })
})

// ─── kb logs show ─────────────────────────────────────────────────

describe('runLogsCommand show', () => {
  it('Given a known runId, then displays stage table', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['show', 'run-100-aaaa'])
    expect(output).toContain('pass1')
    expect(output).toContain('pass2')
    expect(output).toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('Given a prefix of runId, then matches by prefix', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['show', 'run-100'])
    expect(output).toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('Given unknown runId, then throws not found error', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    await expect(run(['show', 'run-999-zzzz'])).rejects.toThrow('Run not found')
    vi.resetModules()
  })

  it('Given show with no runId, then throws usage error', async () => {
    mockLogsDir([])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    await expect(run(['show'])).rejects.toThrow('Usage:')
    vi.resetModules()
  })
})

// ─── kb logs compare ─────────────────────────────────────────────

describe('runLogsCommand compare', () => {
  it('Given two init runs, then compare output contains stage names and deltas', async () => {
    mockLogsDir([initReportA, initReportB])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['compare'])
    expect(output).toContain('pass1')
    expect(output).toContain('pass2')
    expect(output).toContain('Total')
    // Delta column should show a signed value
    expect(output).toMatch(/[+-]\d+/)
    vi.resetModules()
  })

  it('Given compare with --command init, then uses only init runs', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['compare', '--command', 'init'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('run-200-bbbb')
    expect(output).not.toContain('run-300-cccc')
    vi.resetModules()
  })

  it('Given explicit runIds, then compares those two runs', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['compare', 'run-100-aaaa', 'run-300-cccc'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('run-300-cccc')
    vi.resetModules()
  })

  it('Given fewer than 2 runs, then throws with helpful message', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    await expect(run(['compare'])).rejects.toThrow('Need at least 2 runs')
    vi.resetModules()
  })

  it('Given two runs with different stage sets, then union of stages appears in output', async () => {
    const withExtraStage = makeReport({
      ...initReportB,
      runId: 'run-200-bbbb',
      stages: [
        ...initReportB.stages,
        { stage: 'pass-enrich', startedAt: '2026-04-17T09:05:10.000Z', durationMs: 3000, inputTokens: 350, outputTokens: 20, estimatedCostUsd: 0.00003, provider: 'gemini', model: 'gemini-2.0-flash' },
      ],
    })
    mockLogsDir([initReportA, withExtraStage])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['compare'])
    expect(output).toContain('pass-enrich')
    // Stage only present in B should show '-' for A's values
    expect(output).toContain('-')
    vi.resetModules()
  })

  it('Given compare output totals row, then Δms matches difference between runs', async () => {
    mockLogsDir([initReportA, initReportB])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['compare'])
    const expectedDelta = initReportB.totalDurationMs - initReportA.totalDurationMs // -5000
    expect(output).toContain(String(expectedDelta))
    vi.resetModules()
  })
})

// ─── help / unknown subcommand ────────────────────────────────────

describe('runLogsCommand routing', () => {
  it('Given no subcommand, then returns help text', async () => {
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run([])
    expect(output).toContain('kb logs list')
    vi.resetModules()
  })

  it('Given --help, then returns help text', async () => {
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    const output = await run(['--help'])
    expect(output).toContain('kb logs list')
    vi.resetModules()
  })

  it('Given unknown subcommand, then throws with the subcommand name', async () => {
    mockLogsDir([])
    const { runLogsCommand: run } = await import('../../src/cli/logs-cli')
    await expect(run(['bogus'])).rejects.toThrow('bogus')
    vi.resetModules()
  })
})
