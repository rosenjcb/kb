#!/usr/bin/env tsx
/**
 * Compute a codeburn delta, generate a per-task agent-compare artifact, and commit it.
 *
 * Usage:
 *   npm run eval:artifact -- \
 *     --before  /tmp/snap-before.json \
 *     --after   /tmp/snap-after.json  \
 *     --task    1                     \
 *     --agent   kb-backed             \
 *     --run     1                     \
 *     [--base   raylib]               \
 *     [--queries-made   2]            \
 *     [--submissions-made 1]          \
 *     [--completed true]              \
 *     [--notes  "free text ..."]
 *
 * Writes: evaluation/runs/agent-compare/YYYY-MM-DD-run<N>-task-<N>-<agent>.json
 * Then commits the file via git.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Snapshot } from './eval-snapshot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

export interface TaskArtifactOptions {
  before: Snapshot
  after: Snapshot
  taskId: number
  agent: string
  run: number
  base: string | null
  queriesMade: number
  submissionsMade: number
  completed: boolean
  notes: string
}

export interface TaskArtifact {
  task_id: number
  run: number
  agent: string
  base: string | null
  kb_queries_made: number
  kb_submissions_made: number
  codeburn_cost_usd_delta: number
  codeburn_calls_delta: number
  codeburn_snapshot_before: Snapshot
  codeburn_snapshot_after: Snapshot
  task_completed: boolean
  notes: string
}

export function computeDelta(before: Snapshot, after: Snapshot): { cost: number; calls: number } {
  let cost = round4(after.today_cost - before.today_cost)
  let calls = after.today_calls - before.today_calls

  // Crossed midnight — fall back to month delta
  if (cost < 0) {
    cost = round4(after.month_cost - before.month_cost)
    calls = after.month_calls - before.month_calls
  }
  return { cost, calls }
}

export function buildArtifact(opts: TaskArtifactOptions): TaskArtifact {
  const delta = computeDelta(opts.before, opts.after)
  return {
    task_id: opts.taskId,
    run: opts.run,
    agent: opts.agent,
    base: opts.base,
    kb_queries_made: opts.queriesMade,
    kb_submissions_made: opts.submissionsMade,
    codeburn_cost_usd_delta: delta.cost,
    codeburn_calls_delta: delta.calls,
    codeburn_snapshot_before: opts.before,
    codeburn_snapshot_after: opts.after,
    task_completed: opts.completed,
    notes: opts.notes,
  }
}

export function artifactPath(
  repoRoot: string,
  date: string,
  run: number,
  taskId: number,
  agent: string
): string {
  return resolve(
    repoRoot,
    'evaluation/runs/agent-compare',
    `${date}-run${run}-task-${taskId}-${agent}.json`
  )
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// --- CLI entry (only runs when executed directly, not when imported by tests) ---
import { pathToFileURL } from 'node:url'
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? 'true'
      i++
    }
  }
  return args
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2))

  for (const k of ['before', 'after', 'task', 'agent', 'run']) {
    if (!args[k]) {
      console.error(`Missing required flag: --${k}`)
      process.exit(1)
    }
  }

  const before: Snapshot = JSON.parse(readFileSync(args.before, 'utf8'))
  const after: Snapshot = JSON.parse(readFileSync(args.after, 'utf8'))

  const opts: TaskArtifactOptions = {
    before,
    after,
    taskId: Number(args.task),
    agent: args.agent,
    run: Number(args.run),
    base: args.base ?? null,
    queriesMade: Number(args['queries-made'] ?? 0),
    submissionsMade: Number(args['submissions-made'] ?? 0),
    completed: (args.completed ?? 'true') === 'true',
    notes: args.notes ?? '',
  }

  const artifact = buildArtifact(opts)
  const today = new Date().toISOString().slice(0, 10)
  const outPath = artifactPath(REPO_ROOT, today, opts.run, opts.taskId, opts.agent)

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log(`artifact  -> ${outPath}`)
  console.log(`  cost delta:   $${artifact.codeburn_cost_usd_delta.toFixed(4)}`)
  console.log(`  calls delta:  ${artifact.codeburn_calls_delta}`)

  execSync(`git add "${outPath}"`, { cwd: REPO_ROOT, stdio: 'inherit' })
  execSync(
    `git commit -m "eval: agent-compare run${opts.run} task${opts.taskId} ${opts.agent} (${today})\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )
  console.log(`committed ${outPath}`)
}
