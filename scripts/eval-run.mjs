#!/usr/bin/env node
/**
 * Unified kb eval harvest: run 8× `kb query` against a KB session and record results.
 * Layout: `~/.kb/evaluations/<run-name>/` contains `<repo-name>/` clone + artifacts.
 *
 * Session lifecycle is fully automatic:
 *   - Base name is derived from the suite id: `eval-{suiteId}` (e.g. `eval-raylib`, `eval-kb`).
 *   - If the session already has docs → reuse it (query-only run).
 *   - If the session is empty / missing → run `kb init --git <snapshot-clone>` first.
 *   - Every harvest runs `kb scan` (pulls + re-indexes the base's repos), then query.
 *   - `--base NAME` overrides the formula. `--force-init` deletes the base then re-inits from scratch.
 * Ends with an automatic trends summary across prior runs for the same suite.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/eval-run.mjs --suite raylib [--auto-score]
 *   node scripts/eval-run.mjs --suite kb
 *   node scripts/eval-run.mjs --suite generic --repo https://github.com/org/repo.git
 *   node scripts/eval-run.mjs --suite raylib --base my-session   # override session name
 *   node scripts/eval-run.mjs --suite raylib --force-init        # wipe base + fresh init
 *
 * Suites: vendor id → `eval/suites/<id>.yaml` (raylib, kb, generic). `--suite-yaml PATH` for custom.
 * Clone: suite YAML repo_url used by default; override with `--repo <git-url>`.
 */

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import yaml from 'js-yaml'

import {
  sanitizeSlugPart,
  repoLeafNameFromUrl,
  stripCliBanner,
  derivedBase,
  parseQueryText,
  parseGraphCounts,
  buildCoverageAudit,
  scoreMetric,
  structuralMetric,
  matchesSuite,
  sparkline,
  evaluationsRoot,
  normalizeSuiteDoc,
  loadVendorSuite,
  listSuiteIds,
  allocateRunName,
  gitCloneSnapshot,
  printTrendsSummary,
  writeResearchResultsTex,
  findLatestSuiteArtifact,
  conditionSideLabel,
  conditionSideLongLabel,
  suiteDisplayLabel,
  RESEARCH_RESULT_SUITES,
  formatScoreDelta,
  formatCompactTokens,
  formatDurationMs,
  kbControlVerdict,
  worstQuestionGaps,
  computeSuccessScore,
  adequacyUtility,
  computeAdequacyQuality,
  summarizeCuration,
  classifyStageTokens,
  parseRetrievalDetailTrace,
  buildQuestionTimeline,
  buildTimelineSummary,
  printTimelineDiagnosis,
  ADEQUACY_THRESHOLD,
} from './eval-shared.mjs'

import { readQueryResultFile, runAutoScoreFile, scoreFromLabel } from './eval-score.mjs'
import {
  DEFAULT_CONTROL_PROMPT,
  DEFAULT_MAX_TURNS,
  assertControlAgentAvailable,
  buildControlComparison,
  normalizeControlAgent,
  runControlPass,
} from './control-core.mjs'

export {
  sanitizeSlugPart,
  repoLeafNameFromUrl,
  stripCliBanner,
  derivedBase,
  resolveEvalInitPlan,
  parseQueryText,
  parseGraphCounts,
  parseLatestRunIdForCommand,
  logsCmd,
  buildCoverageAudit,
  scoreMetric,
  structuralMetric,
  matchesSuite,
  sparkline,
  formatScoreDelta,
  formatCompactTokens,
  formatDurationMs,
  kbControlVerdict,
  worstQuestionGaps,
  computeSuccessScore,
  adequacyUtility,
  computeAdequacyQuality,
  classifyStageTokens,
  parseRetrievalDetailTrace,
  buildQuestionTimeline,
  buildTimelineSummary,
  printTimelineDiagnosis,
  ADEQUACY_THRESHOLD,
  writeResearchResultsTex,
  findLatestSuiteArtifact,
  conditionSideLabel,
  conditionSideLongLabel,
  suiteDisplayLabel,
  RESEARCH_RESULT_SUITES,
}
export { SUCCESS_WEIGHTS, SUCCESS_BUDGETS, SUCCESS_TOKEN_CACHE_DISCOUNT } from './eval-shared.mjs'
export { computeWeightedTokenTotal } from './eval-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')

/**
 * The kb binary the harvest drives. Defaults to this checkout's build, but `KB_EVAL_BIN`
 * points it at any other `kb.js` — so the *same* (new) eval scripts can score a main-built
 * binary and a branch-built one for a fair before/after. The harness and rubric stay fixed;
 * only the system under test changes.
 */
const KB_BIN = process.env.KB_EVAL_BIN
  ? path.resolve(process.env.KB_EVAL_BIN)
  : path.join(KB_REPO, 'packages/kb-client/dist/bin/kb.js')

function resolveRepoDirInRun(runDir, repoUrl) {
  if (repoUrl && String(repoUrl).trim()) {
    return path.join(runDir, repoLeafNameFromUrl(repoUrl))
  }
  const entries = fs.existsSync(runDir)
    ? fs.readdirSync(runDir, { withFileTypes: true }).filter(e => e.isDirectory())
    : []
  const gitDirs = entries
    .map(entry => path.join(runDir, entry.name))
    .filter(candidate => fs.existsSync(path.join(candidate, '.git')))
  if (gitDirs.length === 1) return gitDirs[0]
  throw new Error(
    `[eval] could not resolve repo dir in ${runDir}; pass --repo or keep exactly one git checkout directory under the run folder`
  )
}

function loadSuiteFromPath(absPath) {
  const resolved = path.resolve(absPath)
  if (!fs.existsSync(resolved)) throw new Error(`[eval] --suite-yaml not found: ${resolved}`)
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  return normalizeSuiteDoc(raw, resolved)
}

function parseArgs(argv) {
  // Accept optional legacy mode positional (init/all/query) for backward compat
  const legacyModes = new Set(['init', 'all', 'query'])
  const first = argv[2]
  const hasLegacyMode = first && !first.startsWith('-') && legacyModes.has(first)
  const out = {
    // init/all legacy → treat as --force-init; query legacy → no-op
    forceInit: first === 'init' || first === 'all',
    suite: null,
    suiteYaml: null,
    repo: null,
    cloneBranch: null,
    cloneDepth: 1,
    questionsFile: null,
    base: null,
    label: null,
    hypothesis: null,
    runDir: null,
    outFile: null,
    scoresFile: null,
    skipCapture: false,
    autoScore: true, // on by default; disable with --manual-score
    autoScoreFile: null,
    scoreRuns: 3,
    // Control condition (the real-agent baseline) runs side-by-side with kb by default.
    skipControl: false,
    controlModel: null,
    controlMaxTurns: DEFAULT_MAX_TURNS,
    controlPrompt: process.env.KB_CONTROL_PROMPT || DEFAULT_CONTROL_PROMPT,
    controlAgent: process.env.KB_CONTROL_AGENT || 'claude',
    controlAgentCmd: process.env.KB_CONTROL_AGENT_CMD || null,
    help: false,
  }
  let i = hasLegacyMode ? 3 : 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--suite') out.suite = argv[++i]
    else if (a === '--suite-yaml') out.suiteYaml = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--clone-branch') out.cloneBranch = argv[++i]
    else if (a === '--clone-depth') out.cloneDepth = Number(argv[++i]) || 0
    else if (a === '--questions-file') out.questionsFile = argv[++i]
    else if (a === '--base') out.base = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--hypothesis') out.hypothesis = argv[++i]
    else if (a === '--run-dir') out.runDir = argv[++i]
    else if (a === '--out') out.outFile = argv[++i]
    else if (a === '--scores-file') out.scoresFile = argv[++i]
    else if (a === '--auto-score-file') {
      out.autoScore = true
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) out.autoScoreFile = argv[++i]
    } else if (a === '--auto-score') out.autoScore = true
    else if (a === '--score-runs' && argv[i + 1])
      out.scoreRuns = Math.max(1, Number.parseInt(argv[++i], 10) || 1)
    else if (a === '--manual-score') out.autoScore = false
    else if (a === '--skip-init') out.skipCapture = true
    else if (a === '--force-init') out.forceInit = true
    else if (a === '--skip-control') out.skipControl = true
    else if (a === '--control-model') out.controlModel = argv[++i]
    else if (a === '--control-max-turns')
      out.controlMaxTurns = Math.max(1, Number.parseInt(argv[++i], 10) || DEFAULT_MAX_TURNS)
    else if (a === '--control-prompt') out.controlPrompt = argv[++i]
    else if (a === '--control-agent') out.controlAgent = normalizeControlAgent(argv[++i])
    else if (a === '--control-agent-cmd') out.controlAgentCmd = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    i++
  }
  return out
}

function assertRemovedEvalFlags(argv) {
  const removed = new Set()
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cwd' || a === '--clone-url' || a === '--clone-dir' || a === '--workdir')
      removed.add(a)
  }
  if (removed.size) {
    throw new Error(
      `[eval] removed flags: ${[...removed].join(', ')} — use --repo <git-url> (clone under ~/.kb/evaluations/<run>/<repo-name>/). Rebuild-only: --skip-init --run-dir ~/.kb/evaluations/<run>/`
    )
  }
}

function printHelp() {
  console.log(`eval-run.mjs — kb query eval harvest (EVALUATION.md schema)

  node scripts/eval-run.mjs --suite <vendor-id> [options]
  npm run eval -- --suite raylib [--auto-score]

Session lifecycle (automatic):
  Base is derived as eval-{suiteId} (e.g. eval-raylib, eval-kb).
  If the session has docs → reuse it (query-only run).
  If the session is empty / missing → kb init --git <snapshot-clone> first.
  Every run: kb scan (pulls + re-indexes the base's repos), then N× kb query (N = suite size).
  Ends with a trends summary across prior runs for the same suite.

Suite / questions:
  --suite VENDOR          Load eval/suites/VENDOR.yaml  (raylib, kb, fzf, generic)
  --suite-yaml PATH       Load pack from arbitrary YAML path
  --questions-file F.json Override: JSON array of non-empty question strings

Session:
  --base NAME             Override derived session name (default: eval-{suiteId})
  --force-init            Delete the base, then kb init from scratch (not just scan)

Target repo (for clone + git metadata):
  --repo URL              Override suite YAML repo_url (https or git@)
  --clone-branch BR
  --clone-depth N         Shallow depth (default 1; use 0 for full clone)

Output:
  --label SLUG            Stored as run_label in artifact
  --out PATH              Override artifact JSON path
  --manual-score          Skip LLM auto-scoring (default: auto-score is ON)
  --score-runs N          Call scorer N times and average (reduces noise; default 3)
  --scores-file PATH      Load manual rubric scores instead (JSON array, one per question)
  --auto-score-file PATH  Write auto-scores to a specific path

Control baseline (runs side-by-side with kb into ONE artifact, scored by the same rubric):
  --skip-control          Do NOT run the control; emit a kb-only artifact (control data omitted)
  --control-agent NAME    Built-in control agent: claude (default) or cursor (Cursor Agent CLI). Env: KB_CONTROL_AGENT
  --control-model NAME    Pin the control agent model (e.g. claude-opus-4-8, composer-2.5)
  --control-max-turns N   Per-question turn ceiling — claude only (default ${DEFAULT_MAX_TURNS})
  --control-prompt TEXT   Wrapper prompt for each control question ({{question}} placeholder). Env: KB_CONTROL_PROMPT
  --control-agent-cmd CMD Full override of --control-agent (prompt on stdin, JSON on stdout). Env: KB_CONTROL_AGENT_CMD

Advanced:
  --run-dir PATH          With --skip-init: reuse existing scratch dir
  --skip-init             Skip all kb commands; re-score existing q*.json
  --hypothesis TEXT
  KB_EVAL_BIN=PATH        Drive a different kb.js (env). Lets these same scripts score a
                          main build vs a branch build for a fair before/after.

Layout (per run, snapshot clone):
  ~/.kb/evaluations/<run-name>/<repo-name>/  git clone
  ~/.kb/evaluations/<run-name>/              scratch (q*.json, logs) + artifact.json
`)
}

function kbEnv() {
  const env = { ...process.env }
  env.KB_HOME = undefined
  // Harvest spawns kb as a subprocess with an isolated KB_HOME; run in-process
  // indexing/retrieval until eval orchestrates kb-server (see eval/EVAL.md).
  env.KB_LOCAL_MODE = 'true'
  // The client bundle lives in packages/kb-client/dist and can't resolve @kb/core's
  // tree-sitter grammars via its own node_modules walk. Point NODE_PATH at kb-core's
  // (and the hoisted root) node_modules so local-mode indexing loads the WASM grammars —
  // the same mechanism the Docker image uses for the server.
  env.NODE_PATH = [
    path.join(KB_REPO, 'packages/kb-core/node_modules'),
    path.join(KB_REPO, 'node_modules'),
    env.NODE_PATH,
  ]
    .filter(Boolean)
    .join(path.delimiter)
  return env
}

function kb(cwd, args, opts = {}) {
  const bin = KB_BIN
  return execSync(`node "${bin}" ${args}`, {
    encoding: 'utf8',
    env: kbEnv(),
    cwd,
    maxBuffer: 50 * 1024 * 1024,
    stdio: opts.stdio === 'inherit' || opts.capture === false ? 'inherit' : undefined,
    ...opts,
  })
}

/** Stream kb stdout/stderr live (no pipe buffer) and write a transcript to `logPath`. */
function kbTee(cwd, args, logPath) {
  const bin = KB_BIN
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, 'w')
  return new Promise((resolve, reject) => {
    const child = spawn(`node "${bin}" ${args}`, {
      cwd,
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
        reject(new Error(`kb exited ${code ?? 'unknown'}\n${output.slice(-4000)}`))
        return
      }
      resolve(output)
    })
  })
}

function timed(label, timings, fn) {
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  try {
    return fn()
  } finally {
    const durationMs = Date.now() - startMs
    timings.command_durations_ms[label] = durationMs
    timings.commands.push({ label, started_at: startedAt, duration_ms: durationMs })
  }
}

async function timedAsync(label, timings, fn) {
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  try {
    return await fn()
  } finally {
    const durationMs = Date.now() - startMs
    timings.command_durations_ms[label] = durationMs
    timings.commands.push({ label, started_at: startedAt, duration_ms: durationMs })
  }
}

/** Returns true if the KB session already has at least one document. */
function sessionHasDocs(targetCwd, base) {
  try {
    const out = kb(targetCwd, `docs list --base ${base}`)
    const m = /Count:\s*(\d+)/.exec(out)
    return m ? Number(m[1]) > 0 : false
  } catch {
    return false
  }
}

/** Decide whether eval should wipe/init vs reuse an existing session. */
function resolveEvalInitPlan({ forceInit = false, skipCapture = false, hasDocs = false }) {
  if (skipCapture) {
    return { needsInit: false, wipeBase: false, evalMode: 'query' }
  }
  const needsInit = forceInit || !hasDocs
  return {
    needsInit,
    wipeBase: forceInit,
    evalMode: needsInit ? 'all' : 'query',
  }
}

function readQueryResult(file) {
  return readQueryResultFile(file)
}

function extractInitAcceptedObject(logText) {
  const anchor = '"status": "accepted"'
  let pos = logText.lastIndexOf(anchor)
  while (pos !== -1) {
    const start = logText.lastIndexOf('{', pos)
    if (start === -1) break
    let depth = 0
    for (let j = start; j < logText.length; j++) {
      const ch = logText[j]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const slice = logText.slice(start, j + 1)
          try {
            const o = JSON.parse(slice)
            if (o.status === 'accepted' && Array.isArray(o.completedCycles)) return o
          } catch {
            /* continue */
          }
          break
        }
      }
    }
    pos = logText.lastIndexOf(anchor, start - 1)
  }
  return null
}

function parseLatestRunIdForCommand(logsText, command) {
  for (const line of logsText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('run-')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2 && parts[1] === command) return parts[0]
  }
  return null
}

function parseLatestInitRunId(logsText) {
  return parseLatestRunIdForCommand(logsText, 'init')
}

function parseLatestScanRunId(logsText) {
  return parseLatestRunIdForCommand(logsText, 'scan')
}

function git(repo, args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd: repo }).trim()
  } catch {
    return 'unknown'
  }
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * @returns {{ runName: string, runDir: string, repoDir: string, targetCwd: string, repoUrl: string | null }}
 */
function resolveEvalPaths(args) {
  const root = evaluationsRoot()

  if (args.skipCapture) {
    if (!args.runDir) {
      throw new Error(
        '[eval] --skip-init requires --run-dir ~/.kb/evaluations/<run-name>/ (scratch from a prior run)'
      )
    }
    const runDir = path.resolve(args.runDir)
    const runName = path.basename(runDir)
    const repoDir = resolveRepoDirInRun(runDir, args.repo || null)
    if (!fs.existsSync(runDir)) {
      throw new Error(`[eval] --run-dir not found: ${runDir}`)
    }
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      throw new Error(`[eval] expected clone at ${repoDir} for kb commands / git metadata`)
    }
    return { runName, runDir, repoDir, targetCwd: repoDir, repoUrl: args.repo || null }
  }

  if (!args.repo || !String(args.repo).trim()) {
    throw new Error(
      '[eval] require repo URL: pass --repo <git-url> or set repo_url in suite YAML (eval clones under ~/.kb/evaluations/<run>/<repo-name>/)'
    )
  }

  const runName = allocateRunName(repoLeafNameFromUrl(args.repo))
  const runDir = path.join(root, runName)
  const repoDir = path.join(runDir, repoLeafNameFromUrl(args.repo))
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })

  gitCloneSnapshot({
    url: args.repo,
    dest: repoDir,
    branch: args.cloneBranch || null,
    depth: args.cloneDepth,
  })

  return { runName, runDir, repoDir, targetCwd: repoDir, repoUrl: args.repo }
}

/** @param {{ questions: string[], rubricPhrase: string }} suiteConfig */
function resolveQuestions(args, suiteConfig) {
  if (args.questionsFile) {
    const qs = JSON.parse(fs.readFileSync(path.resolve(args.questionsFile), 'utf8'))
    if (!Array.isArray(qs) || qs.length === 0 || !qs.every(x => typeof x === 'string' && x.trim())) {
      throw new Error('--questions-file must be a JSON array of non-empty strings')
    }
    return qs
  }
  return suiteConfig.questions
}

/** Recent telemetry for this eval base (init/scan/query). */
function logsCmd(base) {
  return `logs list --base ${base} --limit 10`
}

/**
 * Read kb-side query telemetry directly from the NDJSON run reports
 * (~/.kb/logs/<date>.jsonl). Filters to `query` runs for this base, takes the
 * most recent `limit`, and sums tokens / duration / cost. Mirrors the control
 * block's `control_telemetry` so kb-vs-control comparison is symmetric.
 *
 * @returns {{ questions_answered:number, total_input_tokens:number, total_output_tokens:number, total_cost_usd:number, mean_num_turns:number|null, total_duration_ms:number }|null}
 */
function readKbQueryTelemetry(base, limit = 8) {
  const logsDir = path.join(os.homedir(), '.kb', 'logs')
  if (!fs.existsSync(logsDir)) return null
  const reports = []
  for (const file of fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const text = fs.readFileSync(path.join(logsDir, file), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.command === 'query' && (!base || r.base === base)) reports.push(r)
      } catch {
        /* skip malformed line */
      }
    }
  }
  if (reports.length === 0) return null
  reports.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
  const recent = reports.slice(-limit)
  const sum = key => recent.reduce((a, r) => a + (Number(r[key]) || 0), 0)
  return {
    questions_answered: recent.length,
    total_input_tokens: sum('totalInputTokens'),
    total_output_tokens: sum('totalOutputTokens'),
    total_cost_usd: Number(sum('totalEstimatedCostUsd').toFixed(4)),
    mean_num_turns: null,
    total_duration_ms: sum('totalDurationMs'),
    // Full recent RunReports (one per question, in ask-order) so callers can build the
    // per-question timeline. Not summed — kept raw for stage + retrieval-trace inspection.
    per_question_reports: recent,
  }
}

function readBaseFromInitLog(initLogPath) {
  const t = fs.readFileSync(initLogPath, 'utf8').trim()
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t)
      if (typeof o.base === 'string' && o.base) return o.base
    } catch {
      /* */
    }
  }
  const m = /--base\s+(\S+)/.exec(t)
  return m ? m[1].replace(/['"`]+$/, '') : null
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv
  let args
  try {
    assertRemovedEvalFlags(argv)
    args = parseArgs(argv)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.suiteYaml && args.suite) {
    console.error('[eval] use only one of --suite and --suite-yaml')
    process.exit(1)
  }
  if (!args.suiteYaml && !args.suite) {
    console.error(
      `[eval] require --suite <vendor> or --suite-yaml <path.yaml> (vendors: ${listSuiteIds().join(', ')})`
    )
    process.exit(1)
  }

  let suiteConfig
  try {
    suiteConfig = args.suiteYaml ? loadSuiteFromPath(args.suiteYaml) : loadVendorSuite(args.suite)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }

  const suiteId = suiteConfig.id
  const suiteLabel = suiteDisplayLabel(suiteId)
  if (!args.repo && suiteConfig.repoUrl) {
    args.repo = suiteConfig.repoUrl
  }

  // Control preflight: the control baseline runs by default, so fail fast (before any
  // clone / kb init) if its agent is missing — rather than doing all the kb work first.
  if (!args.skipControl && !args.skipCapture) {
    try {
      assertControlAgentAvailable({
        agentCmd: args.controlAgentCmd,
        controlAgent: args.controlAgentCmd ? 'claude' : args.controlAgent,
        controlPrompt: args.controlPrompt,
      })
    } catch (e) {
      console.error(`[eval] ${e instanceof Error ? e.message : e}`)
      process.exit(1)
    }
  }

  let paths
  try {
    paths = resolveEvalPaths(args)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }

  const { runName, runDir, repoDir, targetCwd, repoUrl } = paths
  if (!fs.existsSync(targetCwd)) {
    console.error(`[eval] clone cwd does not exist: ${targetCwd}`)
    process.exit(1)
  }

  const workdir = runDir
  const questions = resolveQuestions(args, suiteConfig)
  const rubricPhrase = suiteConfig.rubricPhrase

  // Base: user override → formula eval-{suiteId} → fall back from --skip-init scratch
  let base = args.base || derivedBase(suiteId)
  if (args.skipCapture) {
    const initLogPath = path.join(workdir, 'init.log')
    if (!args.base && fs.existsSync(initLogPath)) base = readBaseFromInitLog(initLogPath) || base
  }

  const hasDocs = sessionHasDocs(targetCwd, base)
  const { needsInit, wipeBase, evalMode } = resolveEvalInitPlan({
    forceInit: args.forceInit,
    skipCapture: args.skipCapture,
    hasDocs,
  })

  const label = args.label || runName
  const hypothesis =
    args.hypothesis ||
    (repoUrl
      ? `Eval suite=${suiteId} base=${base} mode=${evalMode} repo=${repoUrl}.`
      : `Eval suite=${suiteId} base=${base} mode=${evalMode} (--skip-init).`)

  if (!args.skipCapture) {
    fs.mkdirSync(workdir, { recursive: true })
  } else if (!fs.existsSync(workdir)) {
    console.error(`[eval] --skip-init requires existing --run-dir: ${workdir}`)
    process.exit(1)
  }

  const kbBin = KB_BIN
  if (!fs.existsSync(kbBin)) {
    console.error(
      process.env.KB_EVAL_BIN
        ? `Missing kb binary at KB_EVAL_BIN=${kbBin} — build it there first (pnpm run build).`
        : 'Missing packages/kb-client/dist/bin/kb.js — run: pnpm run build (or set KB_EVAL_BIN to another kb.js).'
    )
    process.exit(1)
  }

  const runTiming = {
    commands: [],
    command_durations_ms: {},
    query_durations_ms: [],
    query_total_duration_ms: null,
  }

  if (!args.skipCapture) {
    console.error(`[eval] suite=${suiteId} (${suiteLabel}) · base=${base} · mode=${evalMode}`)
    console.error(`[eval] workdir ${workdir}`)
    console.error(`[eval] target cwd ${targetCwd}`)
    console.error(
      `[eval] session "${base}" — ${
        wipeBase
          ? 'force-init: deleting base then kb init + scan'
          : needsInit
            ? 'no docs found, running kb init then scan'
            : 'reusing session; kb scan before K queries'
      }`
    )

    if (wipeBase) {
      console.error(`[eval] kb base delete ${base} --force`)
      timed('base_delete', runTiming, () =>
        kb(targetCwd, `base delete ${base} --force`, { stdio: 'inherit' })
      )
    }

    if (needsInit) {
      // kb init now requires a git remote. Point it at the local snapshot clone (exact commit,
      // no extra network); kb follows the clone's own default branch (main, master, …).
      const initLogPath = path.join(workdir, 'init.log')
      console.error(`[eval] kb init --base ${base} --git "${targetCwd}"`)
      console.error(
        '[eval] kb init clones snapshot into ~/.kb/sessions/… then indexes — progress lines follow'
      )
      await timedAsync('init', runTiming, () =>
        kbTee(
          targetCwd,
          `init --base ${base} --git "${targetCwd}" --non-interactive --debug`,
          initLogPath
        )
      )
    } else {
      runTiming.command_durations_ms.init = 0
      fs.writeFileSync(
        path.join(workdir, 'init.log'),
        `{"note":"query_only_mode","base":"${base}"}\n`,
        'utf8'
      )
    }

    console.error(`[eval] kb scan --base ${base}`)
    const scanLogPath = path.join(workdir, 'scan.log')
    await timedAsync('scan', runTiming, () =>
      kbTee(targetCwd, `scan --base ${base} --debug`, scanLogPath)
    )

    console.error(`[eval] kb base use --default ${base}`)
    timed('base_use_default', runTiming, () =>
      kb(targetCwd, `base use --default ${base}`, { stdio: 'inherit' })
    )

    console.error('[eval] docs list')
    const docsOut = timed('docs_list', runTiming, () => kb(targetCwd, `docs list --base ${base}`))
    fs.writeFileSync(path.join(workdir, 'docs.txt'), docsOut, 'utf8')

    console.error('[eval] graph')
    const graphOut = timed('graph', runTiming, () => kb(targetCwd, `graph --base ${base}`))
    fs.writeFileSync(path.join(workdir, 'graph.txt'), graphOut, 'utf8')

    console.error('[eval] logs list')
    const logsOut = timed('logs_list', runTiming, () => kb(targetCwd, logsCmd(base)))
    fs.writeFileSync(path.join(workdir, 'logs.txt'), logsOut, 'utf8')

    let q = 1
    let queryTotalMs = 0
    for (const question of questions) {
      console.error(`[eval] ${suiteLabel} · K query ${q}/${questions.length}`)
      const escaped = question.replace(/"/g, '\\"')
      const label = `query_${q}`
      const out = timed(label, runTiming, () => kb(targetCwd, `query "${escaped}" --base ${base}`))
      const durationMs = runTiming.command_durations_ms[label]
      runTiming.query_durations_ms.push(durationMs)
      queryTotalMs += durationMs
      fs.writeFileSync(path.join(workdir, `q${q}.json`), out, 'utf8')
      q++
    }
    runTiming.query_total_duration_ms = queryTotalMs
    fs.writeFileSync(path.join(workdir, 'runtime.json'), JSON.stringify(runTiming, null, 2), 'utf8')
  } else {
    const runtimePath = path.join(workdir, 'runtime.json')
    if (fs.existsSync(runtimePath)) {
      Object.assign(runTiming, JSON.parse(fs.readFileSync(runtimePath, 'utf8')))
    }
  }

  const initLogText = fs.readFileSync(path.join(workdir, 'init.log'), 'utf8')
  const initJson = evalMode === 'all' ? extractInitAcceptedObject(initLogText) : null
  const graphText = fs.readFileSync(path.join(workdir, 'graph.txt'), 'utf8')
  const graphCounts = parseGraphCounts(graphText)
  const logsText = fs.readFileSync(path.join(workdir, 'logs.txt'), 'utf8')
  const initRunId = parseLatestInitRunId(logsText)
  const scanRunId = parseLatestScanRunId(logsText)
  const docsListText = fs.existsSync(path.join(workdir, 'docs.txt'))
    ? fs.readFileSync(path.join(workdir, 'docs.txt'), 'utf8')
    : ''
  const docsCountMatch = /Count:\s*(\d+)/.exec(docsListText)
  const docsList = { count: docsCountMatch ? Number(docsCountMatch[1]) : null }

  if (args.scoresFile) args.autoScore = false // --scores-file wins over auto-score default

  let manualScores = null
  let queryScoringMeta = null

  if (args.scoresFile) {
    manualScores = JSON.parse(fs.readFileSync(path.resolve(args.scoresFile), 'utf8'))
    if (!Array.isArray(manualScores) || manualScores.length !== questions.length) {
      console.error(`--scores-file must be a JSON array of length ${questions.length}`)
      process.exit(1)
    }
  } else if (args.autoScore) {
    const outScores = args.autoScoreFile || path.join(workdir, 'auto-scores.json')
    try {
      const res = await runAutoScoreFile({
        workdir,
        questions,
        answers: suiteConfig?.answers ?? null,
        outScoresPath: outScores,
        rubricPhrase,
        scoreRuns: args.scoreRuns,
      })
      manualScores = res.normalized
      queryScoringMeta = {
        mode: args.scoreRuns > 1 ? `llm_judge_avg_${args.scoreRuns}` : 'llm_judge_single_shot',
        provider: res.providerUsed,
        model: res.modelUsed,
        scores_file: res.outScoresPath,
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    }
  }

  const query_evaluation = []
  for (let n = 1; n <= questions.length; n++) {
    const parsed = readQueryResult(path.join(workdir, `q${n}.json`))
    const { answer, result_count, provenance: prov, retrieval } = parsed
    const coverageAudit = buildCoverageAudit(questions[n - 1], answer, retrieval.detail)

    const ms = manualScores?.[n - 1]
    // ms axes may be labels ("mostly_correct") or raw 0–4 levels; scoreFromLabel
    // resolves either to an ordinal level (and is idempotent on the numbers that
    // the auto-scorer already produced).
    const usefulness = ms ? scoreFromLabel('usefulness', ms.usefulness) : 0
    const scores = ms
      ? {
          correctness: scoreFromLabel('correctness', ms.correctness),
          usefulness,
          relevance: ms.relevance != null ? scoreFromLabel('relevance', ms.relevance) : usefulness,
          specificity: scoreFromLabel('specificity', ms.specificity),
          evidence_handling: scoreFromLabel('evidence_handling', ms.evidence_handling),
        }
      : { correctness: 0, usefulness: 0, relevance: 0, specificity: 0, evidence_handling: 0 }
    const notes = ms?.notes?.trim()
      ? ms.notes
      : 'Rubric scores not supplied — use --scores-file or --manual-score to skip auto-scoring.'

    query_evaluation.push({
      question_id: n,
      question: questions[n - 1],
      result_count,
      retrieval,
      answer_excerpt: answer ? answer.slice(0, 280) : null,
      provenance: prov,
      coverage_audit: coverageAudit,
      scores,
      notes,
    })
  }

  const mC = mean(query_evaluation.map(q => q.scores.correctness))
  const mU = mean(query_evaluation.map(q => q.scores.usefulness))
  const mR = mean(query_evaluation.map(q => q.scores.relevance))
  const mS = mean(query_evaluation.map(q => q.scores.specificity))
  const mE = mean(query_evaluation.map(q => q.scores.evidence_handling))
  // Legacy gate (correctness + usefulness) kept for back-compat / trend continuity.
  const pr =
    query_evaluation.filter(q => q.scores.correctness >= 3 && q.scores.usefulness >= 3).length /
    query_evaluation.length
  // Headline gate now also requires relevance ≥ 3 — an off-topic answer no longer passes.
  const prq =
    query_evaluation.filter(
      q => q.scores.correctness >= 3 && q.scores.usefulness >= 3 && q.scores.relevance >= 3
    ).length / query_evaluation.length

  // Retrieval-side relevancy diagnostic: harvest the curator's kept/dropped audit.
  const curationSummary = summarizeCuration(query_evaluation.map(q => q.retrieval?.detail))

  // KB-side query telemetry (tokens + latency) for the composite success score.
  const kbQueryTelemetryRaw = readKbQueryTelemetry(base, questions.length)
  // Per-question run timeline: join each question's RunReport (stage token/time split) with its
  // retrieval trace (passes, hops, curator drops). The raw reports stay out of the summary
  // telemetry block to keep it compact; they live only in the timeline.
  const perQuestionReports = kbQueryTelemetryRaw?.per_question_reports ?? []
  const kbQueryTelemetry = kbQueryTelemetryRaw
    ? (() => {
        const { per_question_reports: _drop, ...rest } = kbQueryTelemetryRaw
        return rest
      })()
    : null
  const queryTimeline = perQuestionReports.map((report, i) =>
    buildQuestionTimeline(report, i + 1, questions[i], query_evaluation[i]?.retrieval?.detail)
  )
  const timelineSummary = buildTimelineSummary(queryTimeline)
  const kbSuccess = computeSuccessScore({
    meanCorrectness: mC,
    meanUsefulness: mU,
    meanRelevance: mR,
    totalTokens: kbQueryTelemetry
      ? kbQueryTelemetry.total_input_tokens + kbQueryTelemetry.total_output_tokens
      : null,
    totalDurationMs: kbQueryTelemetry ? kbQueryTelemetry.total_duration_ms : null,
  })
  const aggregateQueryScores = {
    success_score: kbSuccess.success_score,
    quality_score: kbSuccess.quality_score,
    token_efficiency: kbSuccess.token_efficiency,
    speed_score: kbSuccess.speed_score,
    mean_correctness: Number(mC.toFixed(3)),
    mean_usefulness: Number(mU.toFixed(3)),
    mean_relevance: Number(mR.toFixed(3)),
    mean_specificity: Number(mS.toFixed(3)),
    mean_evidence_handling: Number(mE.toFixed(3)),
    pass_rate_correctness_and_usefulness_at_least_3: Number(pr.toFixed(3)),
    pass_rate_quality_axes_at_least_3: Number(prq.toFixed(3)),
    ...(curationSummary ? { curation_summary: curationSummary } : {}),
  }
  const coverageAuditSummary = {
    mean_coverage_ratio: Number(
      mean(query_evaluation.map(q => q.coverage_audit.coverage_ratio)).toFixed(3)
    ),
    questions_with_missing_facets: query_evaluation
      .filter(q => q.coverage_audit.missing_facets.length > 0)
      .map(q => ({
        question_id: q.question_id,
        missing_facets: q.coverage_audit.missing_facets,
      })),
  }

  const outPath = args.outFile || path.join(runDir, 'artifact.json')

  const branch = git(targetCwd, 'branch --show-current')
  const commit = git(targetCwd, 'rev-parse HEAD')
  const repoName = repoUrl ? repoLeafNameFromUrl(repoUrl) : path.basename(repoDir)

  const qualitative = [
    queryScoringMeta
      ? `Query rubric: auto-scored (${queryScoringMeta.provider} ${queryScoringMeta.model}). Scores: ${queryScoringMeta.scores_file}.`
      : args.scoresFile
        ? `Scores loaded from --scores-file (${path.resolve(args.scoresFile)}).`
        : 'Query scores unset — pass --scores-file or remove --manual-score.',
    `eval_mode=${evalMode} suite=${suiteId} clone=${targetCwd}`,
    repoUrl ? `repo_url=${repoUrl}` : null,
    `Scratch + artifact under ${runDir}; snapshot clone under ${repoDir}`,
  ].filter(Boolean)
  const initOk = evalMode === 'all' && initJson
  const status =
    evalMode === 'all' && !initJson
      ? 'partial'
      : evalMode === 'query'
        ? 'complete'
        : initOk
          ? 'complete'
          : 'partial'

  const artifact = {
    schema_version: 2,
    evaluation_plan: 'EVALUATION.md',
    run_label: label,
    status,
    created_at: dayjs().toISOString(),
    repository: {
      name: repoName,
      branch,
      commit,
      clone_path: repoDir,
    },
    hypothesis,
    run: {
      base,
      condition: 'kb',
      eval_mode: evalMode,
      suite: suiteId,
      run_name: runName,
      evaluations_root: evaluationsRoot(),
      question_suite_file: path.relative(KB_REPO, suiteConfig.sourceFile).split(path.sep).join('/'),
      clone_url: repoUrl,
      target_cwd: targetCwd,
      mode: evalMode === 'query' ? 'query_only_harvest' : 'non_interactive_cli_init',
      commands: [
        'pnpm run build (kb repo)',
        repoUrl ? `git clone (snapshot) → ${targetCwd}` : null,
        wipeBase ? `kb base delete ${base} --force (cwd: ${targetCwd})` : null,
        evalMode === 'all'
          ? `kb init --base ${base} --git "${targetCwd}" --non-interactive --debug (cwd: ${targetCwd})`
          : null,
        `kb scan --base ${base} --debug (cwd: ${targetCwd})`,
        `kb base use --default ${base}`,
        `kb docs list --base ${base} --output json`,
        `kb graph --base ${base}`,
        `kb ${logsCmd(base)}`,
        `kb query "<${questions.length} questions>" --base ${base} --output json`,
      ].filter(Boolean),
      workdir,
      run_dir: runDir,
      publish_dir: null,
      runtime: runTiming,
      init_result: {
        status:
          evalMode === 'query'
            ? 'not_run'
            : initJson?.status === 'accepted'
              ? 'accepted'
              : (initJson?.status ?? 'unknown'),
        written_docs:
          evalMode === 'query'
            ? 0
            : (initJson?.writtenDocIds?.length ?? initJson?.written_docs ?? 0),
        written_doc_ids:
          evalMode === 'query' ? [] : (initJson?.writtenDocIds ?? initJson?.written_doc_ids ?? []),
        init_run_id: initRunId,
        init_run_id_note:
          evalMode === 'query'
            ? 'query-only run: no init executed.'
            : initRunId
              ? null
              : 'Could not parse init run id from kb logs table.',
        scan_run_id: scanRunId,
        scan_run_id_note: scanRunId
          ? null
          : 'Could not parse scan run id from kb logs table.',
        docs_list: docsList,
        graph_summary: {
          entities: graphCounts.entities,
          relationships: graphCounts.relationships,
        },
      },
    },
    question_set: questions,
    query_scoring: queryScoringMeta,
    query_evaluation,
    coverage_audit: coverageAuditSummary,
    chat_evaluation: {
      status: 'not_captured',
      notes:
        'Batch automation: kb chat transcripts not captured. Follow EVALUATION.md Phase 3 for interactive chat when a complete run is required.',
    },
    kb_query_telemetry: kbQueryTelemetry,
    query_timeline: queryTimeline,
    timeline_summary: timelineSummary,
    success_score_inputs: kbSuccess.inputs,
    aggregate_scores: {
      query: aggregateQueryScores,
      chat: {
        success_score: null,
        quality_score: 0,
        token_efficiency: null,
        speed_score: null,
        mean_correctness: 0,
        mean_usefulness: 0,
        mean_relevance: 0,
        mean_specificity: 0,
        mean_evidence_handling: 0,
        pass_rate_correctness_and_usefulness_at_least_3: 0,
        pass_rate_quality_axes_at_least_3: 0,
      },
      combined: aggregateQueryScores,
    },
    qualitative_findings: qualitative,
    next_improvement_areas: [
      'Optional: capture kb chat for status=complete per EVALUATION.md.',
      'Optional: read init token totals from ~/.kb/logs for init_result telemetry.',
    ],
  }

  // ── Control phase: the real-agent baseline, side-by-side with kb ────────────
  // Runs by default; --skip-control omits it (control data simply absent from the JSON).
  // Skipped in --skip-init rescore mode (that path re-scores existing q*.json cheaply and
  // should not trigger fresh, billable agent calls).
  if (args.skipCapture && !args.skipControl) {
    console.error('[eval] --skip-init: control phase not run (rescore-only mode)')
  }
  if (!args.skipControl && !args.skipCapture) {
    const controlLabel = args.controlAgentCmd
      ? 'custom agent cmd'
      : `${args.controlAgent} agent`
    console.error(
      `[eval] control phase · suite=${suiteId} (${suiteLabel}) · ${controlLabel}, condition N (--skip-control to disable)`
    )
    try {
      const control = await runControlPass({
        repoDir: targetCwd,
        workdir: path.join(runDir, 'control'),
        suiteConfig,
        suiteLabel,
        model: args.controlModel,
        maxTurns: args.controlMaxTurns,
        agentCmd: args.controlAgentCmd,
        controlAgent: args.controlAgent,
        controlPrompt: args.controlPrompt,
        autoScore: args.autoScore,
        scoreRuns: args.scoreRuns,
        scoresFile: null,
      })
      artifact.control = control
      artifact.comparison = buildControlComparison(artifact.aggregate_scores, control)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[eval] control phase skipped: ${msg}`)
      artifact.control = { condition: 'control', status: 'error', error: msg }
      artifact.comparison = null
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.error(`[eval] wrote ${outPath}`)

  printTimelineDiagnosis(artifact.timeline_summary, artifact.query_timeline)
  printTrendsSummary(suiteId, KB_REPO, { currentRunId: runName })

  try {
    const { outPath: resultsPath } = writeResearchResultsTex(KB_REPO)
    console.error(`[eval] research results → ${resultsPath}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[eval] research results export skipped: ${msg}`)
  }
}

const _isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (_isMain) {
  main().catch(err => {
    console.error(err instanceof Error ? err.stack || err.message : err)
    process.exit(1)
  })
}
