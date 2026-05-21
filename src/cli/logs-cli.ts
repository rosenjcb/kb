/**
 * kb logs — browse and compare run reports from ~/.kb/logs/
 *
 * Subcommands:
 *   kb logs list [--command <cmd>] [--since <date>] [--limit <n>]
 *   kb logs show <runId>
 *   kb logs compare [<runIdA> <runIdB>] [--command <cmd>] [--since <date>]
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import type { RunReport, StageMetrics } from '../core/telemetry'
import { defaultLogsDir } from '../core/telemetry'
import { type CmdMode, cmd } from './cmd-ref'

// ─── Public entry ─────────────────────────────────────────────────

export async function runLogsCommand(args: string[]): Promise<string> {
  const sub = args[0]

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    return printLogsHelp()
  }

  const logsDir = defaultLogsDir()

  if (sub === 'list') {
    return runLogsList(args.slice(1), logsDir)
  }

  if (sub === 'show') {
    const runId = args[1]
    if (!runId || runId.startsWith('--')) {
      throw new Error('Usage: kb logs show <runId>')
    }
    return runLogsShow(runId, logsDir)
  }

  if (sub === 'compare') {
    return runLogsCompare(args.slice(1), logsDir)
  }

  throw new Error(`Unknown logs subcommand: ${sub}\n\n${printLogsHelp()}`)
}

// ─── list ─────────────────────────────────────────────────────────

async function runLogsList(args: string[], logsDir: string): Promise<string> {
  const command = readOption(args, '--command')
  const since = readOption(args, '--since')
  const limit = parseLimit(readOption(args, '--limit')) ?? 20

  const reports = await loadReports(logsDir, { command, since })
  const recent = reports.slice(-limit).reverse()

  if (recent.length === 0) {
    return 'No run reports found. Run a kb command with --debug or just run it — reports are always written.'
  }

  const hasSession = recent.some(r => r.sessionId)
  const hasBase = recent.some(r => r.base)
  const SESSION_W = 14
  const BASE_W = 16
  const sessionCol = hasSession ? padR('Session', SESSION_W) : ''
  const baseCol = hasBase ? padR('Knowledge Base', BASE_W) : ''
  const header = `${sessionCol}${padR('Run ID', 26)}${padR('Command', 12)}${baseCol}${padR('Started', 22)}${padR('Duration', 10)}${padR('In tok', 8)}${padR('Out tok', 8)}Cost`
  const divider = '─'.repeat(header.length)
  const rows = recent.map(r => {
    const started = dayjs(r.startedAt).format('YYYY-MM-DD HH:mm:ss')
    const duration = formatDuration(r.totalDurationMs)
    const cost = r.totalEstimatedCostUsd > 0 ? `$${r.totalEstimatedCostUsd.toFixed(5)}` : '-'
    const sess = hasSession ? padR(r.sessionId ? r.sessionId.slice(-10) : '-', SESSION_W) : ''
    const base = hasBase ? padR(r.base ?? '-', BASE_W) : ''
    return (
      sess +
      padR(r.runId, 26) +
      padR(r.command, 12) +
      base +
      padR(started, 22) +
      padR(duration, 10) +
      padR(String(r.totalInputTokens), 8) +
      padR(String(r.totalOutputTokens), 8) +
      cost
    )
  })

  const totalInput = recent.reduce((sum, report) => sum + report.totalInputTokens, 0)
  const totalOutput = recent.reduce((sum, report) => sum + report.totalOutputTokens, 0)
  const totalDuration = recent.reduce((sum, report) => sum + report.totalDurationMs, 0)
  const totalCost = recent.reduce((sum, report) => sum + report.totalEstimatedCostUsd, 0)
  const totalRow =
    (hasSession ? padR('', SESSION_W) : '') +
    padR('Total', 26) +
    padR(`${recent.length} run(s)`, 12) +
    (hasBase ? padR('', BASE_W) : '') +
    padR('-', 22) +
    padR(formatDuration(totalDuration), 10) +
    padR(String(totalInput), 8) +
    padR(String(totalOutput), 8) +
    (totalCost > 0 ? `$${totalCost.toFixed(5)}` : '-')

  return [header, divider, ...rows, divider, totalRow].join('\n')
}

// ─── show ─────────────────────────────────────────────────────────

async function runLogsShow(runId: string, logsDir: string): Promise<string> {
  const reports = await loadReports(logsDir, {})
  const report = reports.find(r => r.runId === runId || r.runId.startsWith(runId))
  if (!report) {
    throw new Error(`Run not found: ${runId}`)
  }
  return formatSingleReport(report)
}

function formatSingleReport(report: RunReport): string {
  const lines: string[] = []
  lines.push(`Run:      ${report.runId}`)
  if (report.sessionId && report.sessionId !== report.runId) {
    lines.push(`Session:  ${report.sessionId}`)
  }
  if (report.base) {
    lines.push(`Base:     ${report.base}`)
  }
  lines.push(`Command:  ${report.command}`)
  lines.push(`Started:  ${dayjs(report.startedAt).format('YYYY-MM-DD HH:mm:ss')}`)
  lines.push(`Duration: ${formatDuration(report.totalDurationMs)}`)
  lines.push(`Status:   ${report.status}${report.errorMessage ? ` — ${report.errorMessage}` : ''}`)
  lines.push(`Tokens:   in=${report.totalInputTokens}  out=${report.totalOutputTokens}`)
  lines.push(
    `Cost:     ${report.totalEstimatedCostUsd > 0 ? `$${report.totalEstimatedCostUsd.toFixed(5)}` : '$0'}`
  )
  lines.push('')

  if (report.stages.length === 0) {
    lines.push('No stages recorded.')
    return lines.join('\n')
  }

  const stageHeader = `${padR('Stage', 28) + padR('Duration', 10) + padR('In tok', 8) + padR('Out tok', 8)}Cost`
  const stageDivider = '─'.repeat(stageHeader.length)
  lines.push(stageHeader)
  lines.push(stageDivider)
  for (const s of report.stages) {
    const cost = s.estimatedCostUsd > 0 ? `$${s.estimatedCostUsd.toFixed(5)}` : '-'
    lines.push(
      padR(s.stage, 28) +
        padR(formatDuration(s.durationMs), 10) +
        padR(String(s.inputTokens), 8) +
        padR(String(s.outputTokens), 8) +
        cost
    )
  }
  lines.push(stageDivider)
  const totalCost =
    report.totalEstimatedCostUsd > 0 ? `$${report.totalEstimatedCostUsd.toFixed(5)}` : '-'
  lines.push(
    padR('Total', 28) +
      padR(formatDuration(report.totalDurationMs), 10) +
      padR(String(report.totalInputTokens), 8) +
      padR(String(report.totalOutputTokens), 8) +
      totalCost
  )

  return lines.join('\n')
}

// ─── compare ──────────────────────────────────────────────────────

async function runLogsCompare(args: string[], logsDir: string): Promise<string> {
  const command = readOption(args, '--command')
  const since = readOption(args, '--since')
  const cleanPositionals = extractPositionalIds(args)

  let reportA: RunReport
  let reportB: RunReport

  if (cleanPositionals.length >= 2) {
    const reports = await loadReports(logsDir, {})
    const a = reports.find(
      r => r.runId === cleanPositionals[0] || r.runId.startsWith(cleanPositionals[0])
    )
    const b = reports.find(
      r => r.runId === cleanPositionals[1] || r.runId.startsWith(cleanPositionals[1])
    )
    if (!a) throw new Error(`Run not found: ${cleanPositionals[0]}`)
    if (!b) throw new Error(`Run not found: ${cleanPositionals[1]}`)
    reportA = a
    reportB = b
  } else {
    // Default: last two runs, optionally filtered by command/since
    const reports = await loadReports(logsDir, { command, since })
    if (reports.length < 2) {
      throw new Error(
        `Need at least 2 runs to compare${command ? ` for command "${command}"` : ''}. Found ${reports.length}.`
      )
    }
    reportA = reports[reports.length - 2]
    reportB = reports[reports.length - 1]
  }

  return formatCompare(reportA, reportB)
}

function formatCompare(a: RunReport, b: RunReport): string {
  const lines: string[] = []

  lines.push('Comparing:')
  lines.push(
    `  A: ${a.runId}  kb ${a.command}  ${dayjs(a.startedAt).format('YYYY-MM-DD HH:mm:ss')}`
  )
  lines.push(
    `  B: ${b.runId}  kb ${b.command}  ${dayjs(b.startedAt).format('YYYY-MM-DD HH:mm:ss')}`
  )
  lines.push('')

  // Union all stage names, preserving order of first appearance
  const allStages = unionStageNames(a.stages, b.stages)

  const stageCol = 26
  const numCol = 10
  const header =
    padR('Stage', stageCol) +
    padL('A ms', numCol) +
    padL('B ms', numCol) +
    padL('Δms', numCol) +
    padL('A in', numCol) +
    padL('B in', numCol) +
    padL('Δin', numCol) +
    padL('A out', numCol) +
    padL('B out', numCol) +
    padL('Δout', numCol) +
    padL('A $', 10) +
    padL('B $', 10) +
    padL('Δ$', 10)

  const divider = '─'.repeat(header.length)
  lines.push(header)
  lines.push(divider)

  for (const stage of allStages) {
    const sa = a.stages.find(s => s.stage === stage)
    const sb = b.stages.find(s => s.stage === stage)
    lines.push(formatCompareRow(stage, sa, sb, stageCol, numCol))
  }

  lines.push(divider)

  // Totals row
  const dMs = b.totalDurationMs - a.totalDurationMs
  const dIn = b.totalInputTokens - a.totalInputTokens
  const dOut = b.totalOutputTokens - a.totalOutputTokens
  const dCost = b.totalEstimatedCostUsd - a.totalEstimatedCostUsd

  lines.push(
    padR('Total', stageCol) +
      padL(String(a.totalDurationMs), numCol) +
      padL(String(b.totalDurationMs), numCol) +
      padL(signedNum(dMs), numCol) +
      padL(String(a.totalInputTokens), numCol) +
      padL(String(b.totalInputTokens), numCol) +
      padL(signedNum(dIn), numCol) +
      padL(String(a.totalOutputTokens), numCol) +
      padL(String(b.totalOutputTokens), numCol) +
      padL(signedNum(dOut), numCol) +
      padL(formatCost(a.totalEstimatedCostUsd), 10) +
      padL(formatCost(b.totalEstimatedCostUsd), 10) +
      padL(signedCost(dCost), 10)
  )

  return lines.join('\n')
}

function formatCompareRow(
  stage: string,
  a: StageMetrics | undefined,
  b: StageMetrics | undefined,
  stageCol: number,
  numCol: number
): string {
  const aMs = a?.durationMs ?? 0
  const bMs = b?.durationMs ?? 0
  const aIn = a?.inputTokens ?? 0
  const bIn = b?.inputTokens ?? 0
  const aOut = a?.outputTokens ?? 0
  const bOut = b?.outputTokens ?? 0
  const aCost = a?.estimatedCostUsd ?? 0
  const bCost = b?.estimatedCostUsd ?? 0

  return (
    padR(stage, stageCol) +
    padL(a ? String(aMs) : '-', numCol) +
    padL(b ? String(bMs) : '-', numCol) +
    padL(a && b ? signedNum(bMs - aMs) : '-', numCol) +
    padL(a ? String(aIn) : '-', numCol) +
    padL(b ? String(bIn) : '-', numCol) +
    padL(a && b ? signedNum(bIn - aIn) : '-', numCol) +
    padL(a ? String(aOut) : '-', numCol) +
    padL(b ? String(bOut) : '-', numCol) +
    padL(a && b ? signedNum(bOut - aOut) : '-', numCol) +
    padL(a ? formatCost(aCost) : '-', 10) +
    padL(b ? formatCost(bCost) : '-', 10) +
    padL(a && b ? signedCost(bCost - aCost) : '-', 10)
  )
}

// ─── Report loading ───────────────────────────────────────────────

async function loadReports(
  logsDir: string,
  filters: { command?: string; since?: string }
): Promise<RunReport[]> {
  if (!existsSync(logsDir)) return []

  const files = (await readdir(logsDir)).filter(f => f.endsWith('.jsonl')).sort()

  const sinceMs = filters.since ? parseSince(filters.since) : 0

  const reports: RunReport[] = []
  for (const file of files) {
    // Skip files whose date is before --since
    if (sinceMs > 0) {
      const fileDate = dayjs(file.replace('.jsonl', ''))
      if (fileDate.isValid() && fileDate.valueOf() < dayjs(filters.since).startOf('day').valueOf())
        continue
    }

    const text = await readFile(path.join(logsDir, file), 'utf-8')
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const report = JSON.parse(line) as RunReport
        if (filters.command && report.command !== filters.command) continue
        if (sinceMs > 0 && new Date(report.startedAt).getTime() < sinceMs) continue
        reports.push(report)
      } catch {
        // Malformed line — skip
      }
    }
  }

  return reports
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseSince(value: string): number {
  // Accepts: "1h", "24h", "7d", "30d", or an ISO date string
  const hourMatch = value.match(/^(\d+)h$/)
  if (hourMatch) return Date.now() - Number(hourMatch[1]) * 3600_000

  const dayMatch = value.match(/^(\d+)d$/)
  if (dayMatch) return Date.now() - Number(dayMatch[1]) * 86_400_000

  const d = dayjs(value)
  if (d.isValid()) return d.valueOf()

  throw new Error(`--since: unrecognized format "${value}". Use e.g. 1h, 24h, 7d, or YYYY-MM-DD.`)
}

function unionStageNames(a: StageMetrics[], b: StageMetrics[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const s of [...a, ...b]) {
    if (!seen.has(s.stage)) {
      seen.add(s.stage)
      result.push(s.stage)
    }
  }
  return result
}

function extractPositionalIds(args: string[]): string[] {
  const optionsWithValues = new Set(['--command', '--since', '--limit'])
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (optionsWithValues.has(arg)) i++ // skip value
      continue
    }
    result.push(arg)
  }
  return result
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatCost(usd: number): string {
  if (usd === 0) return '-'
  return `$${usd.toFixed(5)}`
}

function signedNum(n: number): string {
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : String(n)
}

function signedCost(n: number): string {
  if (n === 0) return '0'
  const s = `$${Math.abs(n).toFixed(5)}`
  return n > 0 ? `+${s}` : `-${s}`
}

function padR(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width)
}

function padL(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padStart(width)
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) throw new Error('--limit must be a positive integer')
  return n
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx < 0) return undefined
  const val = args[idx + 1]
  if (!val || val.startsWith('--')) throw new Error(`${flag} requires a value`)
  return val
}

export function printLogsHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('logs', mode)} — browse and compare run reports`,
    '',
    'Usage:',
    `  ${cmd('logs list [--command <cmd>] [--since <1h|7d|YYYY-MM-DD>] [--limit <n>]', mode)}`,
    `  ${cmd('logs show <runId>', mode)}`,
    `  ${cmd('logs compare [<runIdA> <runIdB>] [--command <cmd>] [--since <period>]', mode)}`,
    '',
    'Examples:',
    `  ${cmd('logs list', mode)}`,
    `  ${cmd('logs list --command init --since 7d', mode)}`,
    `  ${cmd('logs compare', mode)}                        # last two runs`,
    `  ${cmd('logs compare --command init', mode)}         # last two init runs`,
    `  ${cmd('logs compare run-abc123 run-def456', mode)}  # specific runs`,
  ].join('\n')
}
