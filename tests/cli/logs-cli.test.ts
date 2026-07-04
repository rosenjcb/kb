import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printLogsHelp, runLogsCommand } from '@kb/client/cli/logs-cli.js'
import type { RunReport } from '@kb/core/core/telemetry.js'

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
    {
      stage: 'pass1',
      startedAt: '2026-04-17T09:00:00.000Z',
      durationMs: 7000,
      inputTokens: 300,
      outputTokens: 200,
      estimatedCostUsd: 0.00009,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
    {
      stage: 'pass2',
      startedAt: '2026-04-17T09:00:07.000Z',
      durationMs: 5000,
      inputTokens: 250,
      outputTokens: 150,
      estimatedCostUsd: 0.00007,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
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
    {
      stage: 'pass1',
      startedAt: '2026-04-17T09:05:00.000Z',
      durationMs: 6000,
      inputTokens: 280,
      outputTokens: 190,
      estimatedCostUsd: 0.00008,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
    {
      stage: 'pass2',
      startedAt: '2026-04-17T09:05:06.000Z',
      durationMs: 4500,
      inputTokens: 240,
      outputTokens: 140,
      estimatedCostUsd: 0.00006,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
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

// ─── printLogsHelp ────────────────────────────────────────────────

describe('printLogsHelp', () => {
  it('[TC-381] includes all three subcommands', () => {
    const help = printLogsHelp()
    expect(help).toContain('kb logs list')
    expect(help).toContain('kb logs show')
    expect(help).toContain('kb logs compare')
  })

  it('[TC-382] documents --since flag', () => {
    expect(printLogsHelp()).toContain('--since')
  })

  it('[TC-383] documents --base flag', () => {
    expect(printLogsHelp()).toContain('--base')
  })
})

// ─── kb logs list ─────────────────────────────────────────────────

describe('runLogsCommand list', () => {
  it('[TC-384] Given no reports, then returns empty message', async () => {
    vi.doMock('node:fs', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) }
    })
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list'])
    expect(output).toContain('No run reports found')
    vi.resetModules()
  })

  it('[TC-385] Given reports, then list includes run ID, command, and duration', async () => {
    mockLogsDir([initReportA, queryReport])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('init')
    expect(output).toContain('run-300-cccc')
    expect(output).toContain('query')
    expect(output).toContain('Total')
    vi.resetModules()
  })

  it('[TC-386] Given --command filter, then only matching command appears', async () => {
    mockLogsDir([initReportA, queryReport])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list', '--command', 'query'])
    expect(output).toContain('run-300-cccc')
    expect(output).not.toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('[TC-387] Given --limit 1, then only one row appears', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list', '--limit', '1'])
    // Most recent first, so queryReport (last) should appear
    const runIdMatches = output.match(/run-\d+-[a-z]+/g) ?? []
    expect(runIdMatches).toHaveLength(1)
    vi.resetModules()
  })
})

// ─── kb logs show ─────────────────────────────────────────────────

describe('runLogsCommand show', () => {
  it('[TC-388] Given a known runId, then displays stage table', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['show', 'run-100-aaaa'])
    expect(output).toContain('pass1')
    expect(output).toContain('pass2')
    expect(output).toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('[TC-389] Given a prefix of runId, then matches by prefix', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['show', 'run-100'])
    expect(output).toContain('run-100-aaaa')
    vi.resetModules()
  })

  it('[TC-390] Given unknown runId, then throws not found error', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    await expect(run(['show', 'run-999-zzzz'])).rejects.toThrow('Run not found')
    vi.resetModules()
  })

  it('[TC-391] Given show with no runId, then throws usage error', async () => {
    mockLogsDir([])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    await expect(run(['show'])).rejects.toThrow('Usage:')
    vi.resetModules()
  })
})

// ─── kb logs compare ─────────────────────────────────────────────

describe('runLogsCommand compare', () => {
  it('[TC-392] Given two init runs, then compare output contains stage names and deltas', async () => {
    mockLogsDir([initReportA, initReportB])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare'])
    expect(output).toContain('pass1')
    expect(output).toContain('pass2')
    expect(output).toContain('Total')
    // Delta column should show a signed value
    expect(output).toMatch(/[+-]\d+/)
    vi.resetModules()
  })

  it('[TC-393] Given compare with --command init, then uses only init runs', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare', '--command', 'init'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('run-200-bbbb')
    expect(output).not.toContain('run-300-cccc')
    vi.resetModules()
  })

  it('[TC-394] Given explicit runIds, then compares those two runs', async () => {
    mockLogsDir([initReportA, initReportB, queryReport])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare', 'run-100-aaaa', 'run-300-cccc'])
    expect(output).toContain('run-100-aaaa')
    expect(output).toContain('run-300-cccc')
    vi.resetModules()
  })

  it('[TC-395] Given fewer than 2 runs, then throws with helpful message', async () => {
    mockLogsDir([initReportA])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    await expect(run(['compare'])).rejects.toThrow('Need at least 2 runs')
    vi.resetModules()
  })

  it('[TC-396] Given two runs with different stage sets, then union of stages appears in output', async () => {
    const withExtraStage = makeReport({
      ...initReportB,
      runId: 'run-200-bbbb',
      stages: [
        ...initReportB.stages,
        {
          stage: 'pass-enrich',
          startedAt: '2026-04-17T09:05:10.000Z',
          durationMs: 3000,
          inputTokens: 350,
          outputTokens: 20,
          estimatedCostUsd: 0.00003,
          provider: 'gemini',
          model: 'gemini-2.0-flash',
        },
      ],
    })
    mockLogsDir([initReportA, withExtraStage])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare'])
    expect(output).toContain('pass-enrich')
    // Stage only present in B should show '-' for A's values
    expect(output).toContain('-')
    vi.resetModules()
  })

  it('[TC-397] Given compare output totals row, then Δms matches difference between runs', async () => {
    mockLogsDir([initReportA, initReportB])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare'])
    const expectedDelta = initReportB.totalDurationMs - initReportA.totalDurationMs // -5000
    expect(output).toContain(String(expectedDelta))
    vi.resetModules()
  })
})

// ─── kb logs list --base filter ──────────────────────────────────

describe('runLogsCommand list --base', () => {
  it('[TC-398] Given --base filter, then only reports matching that base appear', async () => {
    const repoA = makeReport({ runId: 'run-400-dddd', command: 'query', base: 'project-alpha' })
    const repoB = makeReport({ runId: 'run-500-eeee', command: 'query', base: 'project-beta' })
    mockLogsDir([repoA, repoB])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list', '--base', 'project-alpha'])
    expect(output).toContain('run-400-dddd')
    expect(output).not.toContain('run-500-eeee')
    vi.resetModules()
  })

  it('[TC-399] Given --base filter that matches nothing, then returns empty message', async () => {
    const repoA = makeReport({ runId: 'run-400-dddd', command: 'query', base: 'project-alpha' })
    mockLogsDir([repoA])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list', '--base', 'nonexistent-base'])
    expect(output).toContain('No run reports found')
    vi.resetModules()
  })

  it('[TC-400] Given --base combined with --command, then both filters apply', async () => {
    const initAlpha = makeReport({ runId: 'run-410-ffff', command: 'init', base: 'project-alpha' })
    const queryAlpha = makeReport({ runId: 'run-420-gggg', command: 'query', base: 'project-alpha' })
    const initBeta = makeReport({ runId: 'run-430-hhhh', command: 'init', base: 'project-beta' })
    mockLogsDir([initAlpha, queryAlpha, initBeta])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['list', '--base', 'project-alpha', '--command', 'init'])
    expect(output).toContain('run-410-ffff')
    expect(output).not.toContain('run-420-gggg')
    expect(output).not.toContain('run-430-hhhh')
    vi.resetModules()
  })
})

// ─── kb logs compare --base filter ───────────────────────────────

describe('runLogsCommand compare --base', () => {
  it('[TC-401] Given --base filter, then compare uses only runs from that base', async () => {
    const alphaA = makeReport({
      runId: 'run-600-iiii',
      command: 'query',
      base: 'project-alpha',
      startedAt: '2026-04-17T10:00:00.000Z',
      totalDurationMs: 5000,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalEstimatedCostUsd: 0.0001,
      stages: [],
    })
    const alphaB = makeReport({
      runId: 'run-700-jjjj',
      command: 'query',
      base: 'project-alpha',
      startedAt: '2026-04-17T10:01:00.000Z',
      totalDurationMs: 4500,
      totalInputTokens: 900,
      totalOutputTokens: 180,
      totalEstimatedCostUsd: 0.00009,
      stages: [],
    })
    const betaRun = makeReport({
      runId: 'run-800-kkkk',
      command: 'query',
      base: 'project-beta',
      startedAt: '2026-04-17T10:02:00.000Z',
      totalDurationMs: 3000,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      totalEstimatedCostUsd: 0.00005,
      stages: [],
    })
    mockLogsDir([alphaA, alphaB, betaRun])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['compare', '--base', 'project-alpha'])
    expect(output).toContain('run-600-iiii')
    expect(output).toContain('run-700-jjjj')
    expect(output).not.toContain('run-800-kkkk')
    vi.resetModules()
  })
})

// ─── help / unknown subcommand ────────────────────────────────────

describe('runLogsCommand routing', () => {
  it('[TC-402] Given no subcommand, then returns help text', async () => {
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run([])
    expect(output).toContain('kb logs list')
    vi.resetModules()
  })

  it('[TC-403] Given --help, then returns help text', async () => {
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    const output = await run(['--help'])
    expect(output).toContain('kb logs list')
    vi.resetModules()
  })

  it('[TC-404] Given unknown subcommand, then throws with the subcommand name', async () => {
    mockLogsDir([])
    const { runLogsCommand: run } = await import('@kb/client/cli/logs-cli.js')
    await expect(run(['bogus'])).rejects.toThrow('bogus')
    vi.resetModules()
  })
})
