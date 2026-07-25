#!/usr/bin/env node
/**
 * MOEL evaluation harness.
 *
 * Runs kb task suites under three conditions (N/K/O) and computes MOEL loss metrics.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/moel-run.mjs --suite moel-kb [--condition all|N|K|O] [--dry-run]
 *   node scripts/moel-run.mjs --suite moel-kb --condition K
 *
 * Output: ~/.kb/evaluations/moel-{suiteId}-{timestamp}/
 *   trajectory_N.json, trajectory_K.json, trajectory_O.json
 *   moel_results.json, comparison_report.json
 */

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'

import {
  sanitizeSlugPart,
  evaluationsRoot,
  listSuiteIds,
  loadMoelSuite,
  parseQueryText,
  parseGraphCounts,
  formatAnswerTelemetryLog,
  runReportToAnswerTelemetry,
  readLatestKbQueryRunReport,
} from './eval-shared.mjs'
import { startEvalServer, buildEvalOfflineEnv } from './eval-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const EVAL_INDEX = path.join(KB_REPO, 'scripts/eval-index.ts')

// ---------------------------------------------------------------------------
// Default limits (overridable per-task via YAML)
// ---------------------------------------------------------------------------
const DEFAULT_STEP_CEILING = 20
const DEFAULT_TOKEN_BUDGET = 250_000

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    suite: null,
    condition: 'all',
    dryRun: false,
    help: false,
  }
  let i = 2
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--suite' && argv[i + 1]) {
      out.suite = argv[++i]
    } else if (arg === '--condition' && argv[i + 1]) {
      out.condition = argv[++i]
    } else if (arg === '--dry-run') {
      out.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      out.help = true
    }
    i++
  }
  return out
}

function printHelp() {
  process.stdout.write(`
moel-run.mjs — MOEL three-condition evaluation harness

Usage:
  node scripts/moel-run.mjs --suite <suiteId> [options]

Options:
  --suite <id>         Suite id from eval/suites/<id>.yaml (required)
  --condition <N|K|O|all>  Conditions to run (default: all)
  --dry-run            Print plan without executing
  --help               Show this help

Suites: ${listSuiteIds().join(', ') || '(none)'}

Output: ~/.kb/evaluations/moel-{suite}-{timestamp}/
  trajectory_N.json, trajectory_K.json, trajectory_O.json
  moel_results.json, comparison_report.json
`)
}

// ---------------------------------------------------------------------------
// KB subprocess helper
// ---------------------------------------------------------------------------

/** kb subprocess env — offline for init/scan; remote after eval-server starts for queries. */
let kbSubprocessEnv = buildEvalOfflineEnv()

function kbEnv() {
  return kbSubprocessEnv
}

function kb(cwd, args, opts = {}) {
  const bin = path.join(KB_REPO, 'packages/kb-client/dist/bin/kb.js')
  return execSync(`node "${bin}" ${args}`, {
    encoding: 'utf8',
    env: kbEnv(),
    cwd,
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  })
}

/** Stream eval-index (core init/scan) — kb init/scan are not on the client CLI. */
function evalIndexTee(mode, args, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, 'w')
  return new Promise((resolve, reject) => {
    const child = spawn(`pnpm exec tsx "${EVAL_INDEX}" ${mode} ${args}`, {
      cwd: KB_REPO,
      env: kbEnv(),
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    const parts = []
    const relay = (stream, mirror) => {
      stream.on('data', chunk => {
        mirror.write(chunk)
        fs.writeSync(logFd, chunk)
        parts.push(chunk)
      })
    }
    relay(child.stdout, process.stdout)
    relay(child.stderr, process.stderr)
    child.on('error', err => {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
      reject(err)
    })
    child.on('close', code => {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
      const output = Buffer.concat(parts).toString('utf8')
      if (code !== 0) {
        reject(new Error(`eval-index ${mode} exited ${code ?? 'unknown'}\n${output.slice(-4000)}`))
        return
      }
      resolve(output)
    })
  })
}

function sessionHasDocs(_targetCwd, base) {
  const kbHome = process.env.KB_HOME || path.join(os.homedir(), '.kb')
  if (fs.existsSync(path.join(kbHome, 'sessions', base, '.kb-index.sqlite'))) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Run directory management
// ---------------------------------------------------------------------------

function allocateMoelRunDir(suiteId) {
  const dateStr = dayjs().format('YYYY-MM-DD')
  const timeStr = dayjs().format('HHmm')
  const stem = `moel-${sanitizeSlugPart(suiteId)}-${dateStr}-${timeStr}`
  const root = evaluationsRoot()
  let name = stem
  let n = 0
  while (fs.existsSync(path.join(root, name))) {
    n += 1
    name = `${stem}-${n}`
  }
  const runDir = path.join(root, name)
  fs.mkdirSync(runDir, { recursive: true })
  return { runDir, runName: name }
}

// ---------------------------------------------------------------------------
// Trajectory reading
// ---------------------------------------------------------------------------

function readTrajectory(trajPath) {
  if (!fs.existsSync(trajPath)) return null
  try {
    return JSON.parse(fs.readFileSync(trajPath, 'utf8'))
  } catch {
    return null
  }
}

function sumTokens(trajectory) {
  if (!trajectory?.steps) return { fresh: 0, cached: 0, output: 0 }
  let fresh = 0
  let cached = 0
  let output = 0
  for (const step of trajectory.steps) {
    fresh += step.freshTokens ?? 0
    cached += step.cachedTokens ?? 0
    output += step.outputTokens ?? 0
  }
  return { fresh, cached, output }
}

// ---------------------------------------------------------------------------
// Ceiling checks
// ---------------------------------------------------------------------------

function checkCeilings(trajectory, stepCeiling, tokenBudget, delta = 0.1, gamma = 1.0) {
  if (!trajectory?.steps) return null
  const steps = trajectory.steps.length
  if (steps >= stepCeiling) {
    return { reason: 'step_ceiling', steps, budget: stepCeiling }
  }
  const { fresh, cached, output } = sumTokens(trajectory)
  const weightedTotal = fresh + delta * cached + gamma * output
  if (weightedTotal >= tokenBudget) {
    return { reason: 'token_budget', weightedTotal, budget: tokenBudget }
  }
  return null
}

// ---------------------------------------------------------------------------
// Simple MOEL metric computation (placeholder until dist/ exports are wired)
// ---------------------------------------------------------------------------

function computeSimpleMoelLoss(queryResult, terminated, terminatedBy) {
  if (terminated) {
    return { lTrajectory: 1.0, lResource: 1.0, lMoel: 1.0, terminatedBy }
  }
  const hasAnswer = typeof queryResult?.answer === 'string' && queryResult.answer.length > 20
  const lCorrectness = hasAnswer ? 0.3 : 0.8
  return {
    lTrajectory: 0.5,
    lResource: 0.4,
    lCorrectness,
    lMoel: 0.5 * lCorrectness + 0.3 * 0.5 + 0.2 * 0.4,
    terminatedBy: null,
  }
}

// ---------------------------------------------------------------------------
// Single-condition run for one task
// ---------------------------------------------------------------------------

async function runCondition(condition, task, suite, repoPath, runDir, opts) {
  const { dryRun } = opts
  const base = `moel-${sanitizeSlugPart(suite.id)}-${condition}`
  const trajPath = path.join(runDir, `trajectory_${condition}.json`)
  const stepCeiling = task.stepCeiling ?? DEFAULT_STEP_CEILING
  const tokenBudget = task.tokenBudget ?? DEFAULT_TOKEN_BUDGET

  console.log(`  [${condition}] base=${base} stepCeiling=${stepCeiling} tokenBudget=${tokenBudget}`)

  if (dryRun) {
    console.log(`  [${condition}] DRY RUN — skipping execution`)
    return {
      condition,
      taskId: task.id,
      base,
      queryResult: null,
      trajectory: null,
      terminated: false,
      terminatedBy: null,
      loss: null,
    }
  }

  let evalServer = null
  try {
    kbSubprocessEnv = buildEvalOfflineEnv()

    if (!sessionHasDocs(repoPath, base)) {
      console.log(`  [${condition}] Initializing kb session via eval-index (base=${base})…`)
      try {
        const initLogPath = path.join(runDir, `init-${condition}.log`)
        await evalIndexTee(
          'init',
          `--base ${base} --git "${repoPath}" --non-interactive --debug`,
          initLogPath
        )
        const scanLogPath = path.join(runDir, `scan-${condition}.log`)
        await evalIndexTee('scan', `--base ${base} --debug`, scanLogPath)
      } catch (err) {
        console.error(`  [${condition}] Init/scan failed: ${err.message}`)
      }
    } else {
      console.log(`  [${condition}] Session exists, reusing (base=${base})`)
    }

    // Check ceilings before running (read existing trajectory if any)
    const existingTraj = readTrajectory(trajPath)
    const preCheck = checkCeilings(existingTraj, stepCeiling, tokenBudget)
    if (preCheck) {
      console.warn(`  [${condition}] Ceiling hit before run: ${preCheck.reason}`)
      return {
        condition,
        taskId: task.id,
        base,
        queryResult: null,
        trajectory: existingTraj,
        terminated: true,
        terminatedBy: preCheck.reason,
        loss: computeSimpleMoelLoss(null, true, preCheck.reason),
      }
    }

    console.log(`  [${condition}] starting kb-server for remote query`)
    evalServer = await startEvalServer({
      base,
      logPath: path.join(runDir, `eval-server-${condition}.log`),
    })
    kbSubprocessEnv = evalServer.kbEnv()

    console.log(`  [${condition}] waiting for kb-server index readiness before query`)
    await evalServer.waitReady()

    // Run the query
    let queryOutput = ''
    let queryResult = null
    try {
      const question = task.question ?? suite.questions[0]
      const queryStartMs = Date.now()
      queryOutput = kb(repoPath, `query "${question.replace(/"/g, '\\"')}" --base ${base}`)
      queryResult = parseQueryText(queryOutput)
      const report = readLatestKbQueryRunReport(base, { minFinishedAtMs: queryStartMs - 500 })
      const telemetry = runReportToAnswerTelemetry(report)
      console.log(`  [${condition}] answer ${formatAnswerTelemetryLog(telemetry)}`)
    } catch (err) {
      console.error(`  [${condition}] Query failed: ${err.message}`)
    }

    // Read trajectory written by kb session
    const trajectory = readTrajectory(trajPath)

    // Post-run ceiling check
    const postCheck = checkCeilings(trajectory, stepCeiling, tokenBudget)
    const terminated = postCheck !== null
    const terminatedBy = postCheck?.reason ?? null

    if (terminated) {
      console.warn(`  [${condition}] Ceiling hit after run: ${terminatedBy}`)
    }

    const loss = computeSimpleMoelLoss(queryResult, terminated, terminatedBy)

    return {
      condition,
      taskId: task.id,
      base,
      queryResult,
      trajectory,
      terminated,
      terminatedBy,
      loss,
    }
  } finally {
    if (evalServer) {
      await evalServer.stop()
    }
    kbSubprocessEnv = buildEvalOfflineEnv()
  }
}

// ---------------------------------------------------------------------------
// Per-task MOEL run across conditions
// ---------------------------------------------------------------------------

async function runTask(task, suite, repoPath, runDir, conditions, opts) {
  console.log(`\nTask: ${task.id}`)
  console.log(`  question: ${(task.question ?? '').slice(0, 80)}…`)

  const results = {}
  for (const condition of conditions) {
    results[condition] = await runCondition(condition, task, suite, repoPath, runDir, opts)
  }

  // Write trajectory files
  for (const condition of conditions) {
    const result = results[condition]
    if (result.trajectory) {
      const trajPath = path.join(runDir, `trajectory_${condition}.json`)
      fs.writeFileSync(trajPath, JSON.stringify(result.trajectory, null, 2))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

function buildComparisonReport(allTaskResults, runName) {
  const hypothesis = allTaskResults.every(taskResults => {
    const n = taskResults.N?.loss?.lMoel
    const k = taskResults.K?.loss?.lMoel
    return typeof n === 'number' && typeof k === 'number' ? n > k : true
  })

  return {
    schemaVersion: 1,
    runName,
    hypothesisConfirmed: hypothesis,
    tasks: allTaskResults.map(taskResults => {
      const conditions = Object.keys(taskResults)
      const first = taskResults[conditions[0]]
      return {
        taskId: first?.taskId ?? 'unknown',
        conditions: Object.fromEntries(
          conditions.map(c => [c, {
            lMoel: taskResults[c]?.loss?.lMoel ?? null,
            terminated: taskResults[c]?.terminated ?? false,
            terminatedBy: taskResults[c]?.terminatedBy ?? null,
          }])
        ),
        nKDelta: (taskResults.N?.loss?.lMoel ?? null) !== null && (taskResults.K?.loss?.lMoel ?? null) !== null
          ? taskResults.N.loss.lMoel - taskResults.K.loss.lMoel
          : null,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)

  if (args.help || !args.suite) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }

  const conditions = args.condition === 'all'
    ? ['N', 'K', 'O']
    : [args.condition.toUpperCase()].filter(c => ['N', 'K', 'O'].includes(c))

  if (conditions.length === 0) {
    console.error(`[moel] Invalid --condition: ${args.condition}. Use N, K, O, or all.`)
    process.exit(1)
  }

  // Load suite
  let suite
  try {
    suite = loadMoelSuite(args.suite)
  } catch (err) {
    console.error(`[moel] ${err.message}`)
    process.exit(1)
  }

  const tasks = suite.tasks
  if (!tasks || tasks.length === 0) {
    console.error(`[moel] Suite '${args.suite}' has no tasks array. MOEL requires per-task metadata.`)
    process.exit(1)
  }

  // Resolve repo path (use suite repo_url via existing kb session if initialized)
  const repoPath = KB_REPO  // Default to the kb repo itself for dogfood suites

  // Allocate run directory
  const { runDir, runName } = allocateMoelRunDir(args.suite)
  console.log(`[moel] Run: ${runName}`)
  console.log(`[moel] Output: ${runDir}`)
  console.log(`[moel] Suite: ${suite.id} (${tasks.length} tasks)`)
  console.log(`[moel] Conditions: ${conditions.join(', ')}`)

  if (args.dryRun) {
    console.log('[moel] DRY RUN — no sessions will be created')
  }

  // Codebase anchor check
  try {
    const yamlContent = fs.readFileSync(suite.sourceFile, 'utf8')
    const anchorMatch = /# Codebase anchor: commit ([a-f0-9]+)/i.exec(yamlContent)
    if (anchorMatch) {
      const anchorCommit = anchorMatch[1]
      const currentHead = execSync('git rev-parse --short HEAD', { cwd: KB_REPO, encoding: 'utf8' }).trim()
      if (!currentHead.startsWith(anchorCommit) && !anchorCommit.startsWith(currentHead)) {
        console.warn(`[moel] WARNING: repo HEAD (${currentHead}) differs from suite anchor (${anchorCommit})`)
        console.warn('[moel]          targetSymbols may not match current codebase')
      }
    }
  } catch {
    // Non-fatal
  }

  // Run all tasks across all conditions
  const allTaskResults = []
  for (const task of tasks) {
    const taskResults = await runTask(task, suite, repoPath, runDir, conditions, args)
    allTaskResults.push(taskResults)
  }

  // Write moel_results.json
  const moelResultsPath = path.join(runDir, 'moel_results.json')
  fs.writeFileSync(moelResultsPath, JSON.stringify(
    {
      schemaVersion: 1,
      runName,
      suite: suite.id,
      conditions,
      tasks: allTaskResults.map(taskResults =>
        Object.fromEntries(
          Object.entries(taskResults).map(([c, r]) => [c, {
            taskId: r.taskId,
            condition: r.condition,
            loss: r.loss,
            terminated: r.terminated,
            terminatedBy: r.terminatedBy,
            queryResultCount: r.queryResult?.result_count ?? null,
            compaction: { triggered: false, events: [] },
          }])
        )
      ),
    },
    null, 2
  ))
  console.log(`\n[moel] MOEL results written to ${moelResultsPath}`)

  // Write comparison_report.json
  const reportPath = path.join(runDir, 'comparison_report.json')
  const report = buildComparisonReport(allTaskResults, runName)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`[moel] Comparison report written to ${reportPath}`)

  // Print summary
  console.log('\n[moel] Summary:')
  console.log('  Task                          | N L_MOEL | K L_MOEL | O L_MOEL | N-K Delta')
  console.log('  ------------------------------|----------|----------|----------|----------')
  for (const taskResults of allTaskResults) {
    const first = taskResults[conditions[0]]
    const taskId = (first?.taskId ?? 'unknown').slice(0, 28).padEnd(28)
    const n = taskResults.N?.loss?.lMoel
    const k = taskResults.K?.loss?.lMoel
    const o = taskResults.O?.loss?.lMoel
    const fmtLoss = v => v != null ? v.toFixed(3) : '  -  '
    const delta = n != null && k != null ? (n - k >= 0 ? '+' : '') + (n - k).toFixed(3) : '  -  '
    console.log(`  ${taskId} | ${fmtLoss(n).padStart(8)} | ${fmtLoss(k).padStart(8)} | ${fmtLoss(o).padStart(8)} | ${delta.padStart(9)}`)
  }
  console.log()
  console.log(`[moel] hypothesisConfirmed: ${report.hypothesisConfirmed}`)
  console.log('[moel] Done.')
}

main().catch(err => {
  console.error('[moel] Fatal:', err)
  process.exit(1)
})
