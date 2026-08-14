/**
 * kb session — inspect the most recent chat session (or a named one).
 *
 *   kb session                     Summary of the most recent session's runs
 *   kb session --session <id>      Summary of a specific session (id or prefix)
 *   kb session --base <name>       Restrict to a single base
 *
 * A "session" groups the run reports written under ~/.kb/logs/ that share a
 * `sessionId` — the per-turn reports a chat conversation produces. This is the
 * read side of the session↔logs coupling: your live conversation becomes log
 * entries you can snoop after the fact with `kb logs show <runId>`.
 */

import dayjs from 'dayjs'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import type { RunReport } from '@kb/core/core/telemetry.js'
import {
  defaultLogsDir,
  formatLogTarget,
  normalizeRunCommand,
} from '@kb/core/core/telemetry.js'
import { loadReports } from '@kb/core/cli/logs-cli.js'

export function printSessionHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('session', mode)} — inspect the most recent chat session`,
    '',
    'Usage:',
    `  ${cmd('session', mode)}                     Summary of the most recent session`,
    `  ${cmd('session --session <id>', mode)}      Summary of a specific session (id or prefix)`,
    `  ${cmd('session --base <name>', mode)}        Restrict to a single base`,
    '',
    'A session groups the run reports that share a sessionId — the per-turn reports',
    'a chat conversation writes. Drill into any single run with `kb logs show <runId>`.',
  ].join('\n')
}

export async function runSessionCommand(args: string[]): Promise<string> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    return printSessionHelp()
  }

  const base = readOption(args, '--base')
  const wantedSession = readOption(args, '--session')

  const reports = (await loadReports(defaultLogsDir(), { base })).filter(r => r.sessionId)
  if (reports.length === 0) {
    return 'No chat sessions found yet. Start a conversation with `kb query` or the TUI.'
  }

  const sessionId = wantedSession
    ? resolveSessionId(reports, wantedSession)
    : mostRecentSessionId(reports)
  if (!sessionId) {
    throw new Error(`Session not found: ${wantedSession}`)
  }

  const runs = reports
    .filter(r => r.sessionId === sessionId)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())

  return formatSession(sessionId, runs)
}

function mostRecentSessionId(reports: RunReport[]): string | undefined {
  let latest: RunReport | undefined
  for (const r of reports) {
    if (!latest || new Date(r.startedAt).getTime() > new Date(latest.startedAt).getTime()) {
      latest = r
    }
  }
  return latest?.sessionId
}

function resolveSessionId(reports: RunReport[], wanted: string): string | undefined {
  const exact = reports.find(r => r.sessionId === wanted)
  if (exact) return exact.sessionId
  const prefix = reports.find(r => r.sessionId?.startsWith(wanted))
  return prefix?.sessionId
}

function formatSession(sessionId: string, runs: RunReport[]): string {
  const first = runs[0]
  const last = runs[runs.length - 1]
  const totalIn = runs.reduce((sum, r) => sum + r.totalInputTokens, 0)
  const totalOut = runs.reduce((sum, r) => sum + r.totalOutputTokens, 0)
  const totalCost = runs.reduce((sum, r) => sum + r.totalEstimatedCostUsd, 0)
  const totalMs = runs.reduce((sum, r) => sum + r.totalDurationMs, 0)
  const target = formatLogTarget(last.host, last.base)

  const commandCounts = new Map<string, number>()
  for (const r of runs) {
    const name = normalizeRunCommand(r.command)
    commandCounts.set(name, (commandCounts.get(name) ?? 0) + 1)
  }
  const commandBreakdown = [...commandCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(', ')

  const lines: string[] = []
  lines.push(`Session:  ${sessionId}`)
  if (target) lines.push(`Target:   ${target}`)
  lines.push(`Runs:     ${runs.length}${commandBreakdown ? ` (${commandBreakdown})` : ''}`)
  lines.push(`Started:  ${dayjs(first.startedAt).format('YYYY-MM-DD HH:mm:ss')}`)
  lines.push(`Latest:   ${dayjs(last.startedAt).format('YYYY-MM-DD HH:mm:ss')}`)
  lines.push(`Duration: ${formatDuration(totalMs)}`)
  lines.push(`Tokens:   in=${totalIn}  out=${totalOut}`)
  lines.push(`Cost:     ${totalCost > 0 ? `$${totalCost.toFixed(5)}` : '$0'}`)
  lines.push('')
  lines.push('Runs (newest last) — inspect any with `kb logs show <runId>`:')
  for (const r of runs) {
    const started = dayjs(r.startedAt).format('HH:mm:ss')
    const status = r.status === 'success' ? '' : ` [${r.status}]`
    lines.push(`  ${started}  ${padR(normalizeRunCommand(r.command), 10)} ${r.runId}${status}`)
  }

  const transcript = runs.flatMap(r => r.turns ?? [])
  if (transcript.length > 0) {
    lines.push('')
    lines.push('Transcript:')
    for (const turn of transcript) {
      const label = turn.role === 'user' ? 'you' : 'kb '
      lines.push(`  ${label} │ ${turn.text.replace(/\n/g, '\n      │ ')}`)
    }
  }
  return lines.join('\n')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function padR(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width)
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx < 0) return undefined
  const val = args[idx + 1]
  if (!val || val.startsWith('--')) throw new Error(`${flag} requires a value`)
  return val
}
