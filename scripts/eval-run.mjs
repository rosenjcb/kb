#!/usr/bin/env node
/**
 * Unified kb eval harvest: run 8× `kb query` against a KB session and record results.
 * Layout: `~/.kb/evaluations/<run-name>/` contains `<repo-name>/` clone + artifacts.
 *
 * Session lifecycle is fully automatic:
 *   - Base name is derived from the suite id: `eval-{suiteId}` (e.g. `eval-raylib`, `eval-kb`).
 *   - If the session already has docs → reuse it (query-only run).
 *   - If the session is empty / missing → run core init via scripts/eval-index.ts first.
 *   - Every harvest runs core scan (eval-index), then query — unless `--skip-scan`.
 *   - `--base NAME` overrides the formula. `--force-init` deletes the base then re-inits from scratch.
 * Ends with an automatic trends summary across prior runs for the same suite.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/eval-run.mjs --suite raylib [--auto-score]
 *   node scripts/eval-run.mjs --suite kb
 *   node scripts/eval-run.mjs --suite generic --repo https://github.com/org/repo.git
 *   node scripts/eval-run.mjs --suites raylib,kb,fzf            # multi-suite (parallel by default)
 *   node scripts/eval-run.mjs --all-suites                      # 10 benchmark suites, parallel
 *   node scripts/eval-run.mjs --all-suites --skip-control --skip-scan
 *   node scripts/eval-run.mjs --all-suites --sequential         # same, one at a time
 *   node scripts/eval-run.mjs --suite raylib --base my-session   # override session name
 *   node scripts/eval-run.mjs --suite raylib --force-init        # wipe base + fresh init
 *
 * Entity harvest report (no query): after scan/index, dump ontology entities with
 *   `pnpm run eval:entities -- --suite <id>|--base eval-<id>|--all-suites`
 * (see `scripts/eval-entities.mjs`). Prefer that over a full eval-run when you only
 * need kind counts / sample names from `~/.kb/sessions/<base>/.kb-index.sqlite`.
 *
 * Suites: vendor id → `eval/suites/<id>.yaml` (raylib, kb, generic). `--suite-yaml PATH` for custom.
 * Clone: suite YAML repo_url used by default; override with `--repo <git-url>`.
 * Multi-suite: Node spawns one child eval per suite (portable — no bash/xargs). Parallel by default.
 * Multi-suite servers: one shared multi-base kb-server (X-KB-Base / --base per suite). Use
 * `--per-suite-server` to restore the old one-process-per-suite ephemeral-port model.
 */

import { exec, execSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
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
  startEvalServer,
  buildEvalOfflineEnv,
  defaultEvalApiKey,
} from './eval-server.mjs'
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
  parseArgs,
}
export { SUCCESS_WEIGHTS, SUCCESS_BUDGETS, SUCCESS_TOKEN_CACHE_DISCOUNT } from './eval-shared.mjs'
export { computeWeightedTokenTotal } from './eval-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const EVAL_INDEX = path.join(KB_REPO, 'scripts/eval-index.ts')
const THIS_SCRIPT = fileURLToPath(import.meta.url)

/**
 * Canonical 10-suite benchmark pack from EVALUATION.md (excludes `generic` which needs
 * `--repo`, and `moel-kb` which is the separate MOEL harness).
 */
export const DEFAULT_BENCHMARK_SUITES = [
  'raylib',
  'kb',
  'fzf',
  'kestra',
  'shellcheck',
  'lazygit',
  'datasette',
  'mitmproxy',
  'fish-shell',
  'brew',
]

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

/** Split a suite list token: `a,b,c` or `a b c`. */
export function parseSuiteListToken(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Dedupe suite ids, preserve first-seen order. */
export function dedupeSuites(suites) {
  const seen = new Set()
  const out = []
  for (const s of suites) {
    const id = String(s).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Resolve the suite id list for this invocation.
 * `--all-suites` wins over explicit `--suite` / `--suites` lists.
 */
export function resolveSuiteList(args) {
  if (args.allSuites) return [...DEFAULT_BENCHMARK_SUITES]
  return dedupeSuites(args.suites ?? [])
}

/**
 * Concurrency for multi-suite batch.
 * Default = one worker per suite (full parallel). `--sequential` forces 1.
 * `--parallel N` caps concurrency; bare `--parallel` (=0) means suite count.
 * Env `KB_EVAL_PARALLEL` applies when `--parallel` was not passed.
 */
export function resolveParallelism({
  suiteCount,
  parallel = null,
  sequential = false,
  env = process.env,
} = {}) {
  if (suiteCount <= 1) return 1
  if (sequential) return 1
  if (parallel != null) {
    if (parallel <= 0) return suiteCount
    return Math.min(parallel, suiteCount)
  }
  const envN = Number.parseInt(env.KB_EVAL_PARALLEL ?? '', 10)
  if (Number.isFinite(envN) && envN > 0) return Math.min(envN, suiteCount)
  return suiteCount
}

/** Flags that only make sense for a single-suite run. */
export function assertMultiSuiteArgsOk(args, suites) {
  if (suites.length <= 1) return
  const bad = []
  if (args.suiteYaml) bad.push('--suite-yaml')
  if (args.repo) bad.push('--repo')
  if (args.base) bad.push('--base')
  if (args.runDir) bad.push('--run-dir')
  if (args.outFile) bad.push('--out')
  if (args.questionsFile) bad.push('--questions-file')
  if (bad.length) {
    throw new Error(
      `[eval] multi-suite mode cannot combine with: ${bad.join(', ')} (pass per-suite via separate runs)`
    )
  }
}

/**
 * Child argv for one suite under a multi-suite parent.
 * Strips multi-suite-only flags; forwards shared harvest/control knobs.
 */
export function buildChildArgv(suite, args) {
  const argv = ['--suite', suite]
  if (args.label) argv.push('--label', args.label)
  if (args.hypothesis) argv.push('--hypothesis', args.hypothesis)
  if (args.forceInit) argv.push('--force-init')
  if (args.skipCapture) argv.push('--skip-init')
  if (args.skipScan) argv.push('--skip-scan')
  if (args.skipControl) argv.push('--skip-control')
  if (args.queryTrace) argv.push('--trace')
  if (args.autoScore === false) argv.push('--manual-score')
  else argv.push('--auto-score')
  if (args.autoScoreFile) argv.push('--auto-score-file', args.autoScoreFile)
  if (args.scoresFile) argv.push('--scores-file', args.scoresFile)
  if (args.scoreRuns != null) argv.push('--score-runs', String(args.scoreRuns))
  if (args.queryTrials != null && args.queryTrials !== 1)
    argv.push('--query-trials', String(args.queryTrials))
  if (args.cloneBranch) argv.push('--clone-branch', args.cloneBranch)
  if (args.cloneDepth != null && args.cloneDepth !== 1)
    argv.push('--clone-depth', String(args.cloneDepth))
  if (args.controlModel) argv.push('--control-model', args.controlModel)
  if (args.controlMaxTurns != null && args.controlMaxTurns !== DEFAULT_MAX_TURNS)
    argv.push('--control-max-turns', String(args.controlMaxTurns))
  if (args.controlPrompt && args.controlPrompt !== DEFAULT_CONTROL_PROMPT)
    argv.push('--control-prompt', args.controlPrompt)
  if (args.controlAgent && args.controlAgent !== 'claude')
    argv.push('--control-agent', args.controlAgent)
  if (args.controlAgentCmd) argv.push('--control-agent-cmd', args.controlAgentCmd)
  return argv
}

function prefixChildStream(stream, suite, write) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buf += chunk
    while (true) {
      const idx = buf.indexOf('\n')
      if (idx === -1) break
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      write(`[${suite}] ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buf.length) write(`[${suite}] ${buf}\n`)
  })
}

/**
 * Env for a multi-suite child.
 *
 * Shared multi-base mode (default): keep `KB_EVAL_SERVER_URL` so children attach to the
 * parent-spawned server and select `eval-{suite}` via `--base` / `X-KB-Base`.
 *
 * Per-suite server mode (`--per-suite-server`): strip attach/port pins so each child
 * allocates its own ephemeral kb-server (legacy isolation).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ sharedServer?: boolean }} [opts]
 */
export function buildMultiSuiteChildEnv(env = process.env, { sharedServer = true } = {}) {
  const out = { ...env }
  out.KB_EVAL_SERVER_PORT = undefined
  if (sharedServer) {
    // Parent sets KB_EVAL_SERVER_URL (+ API key). Keep attach; never pin a port.
    return out
  }
  out.KB_EVAL_SERVER_URL = undefined
  out.KB_EVAL_ATTACH_URL = undefined
  return out
}

/** Spawn one single-suite eval child; resolve `{ suite, code, signal }`. */
export function spawnSuiteChild(
  suite,
  args,
  { scriptPath = THIS_SCRIPT, cwd = KB_REPO, env = process.env, sharedServer = true } = {}
) {
  return new Promise(resolve => {
    const childArgv = buildChildArgv(suite, args)
    console.error(`[eval] multi-suite · starting ${suite}`)
    const child = spawn(process.execPath, [scriptPath, ...childArgv], {
      cwd,
      env: buildMultiSuiteChildEnv(env, { sharedServer }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    prefixChildStream(child.stdout, suite, s => process.stdout.write(s))
    prefixChildStream(child.stderr, suite, s => process.stderr.write(s))
    child.on('error', err => {
      console.error(`[eval] multi-suite · ${suite} spawn failed: ${err.message}`)
      resolve({ suite, code: 1, signal: null, error: err.message })
    })
    child.on('close', (code, signal) => {
      const ok = code === 0 && !signal
      console.error(
        ok
          ? `[eval] multi-suite · OK ${suite}`
          : `[eval] multi-suite · FAIL ${suite} exit=${code}${signal ? ` signal=${signal}` : ''}`
      )
      resolve({ suite, code: code ?? 1, signal })
    })
  })
}

/**
 * Run many suites via child processes. Parallel by default (Node-native, portable).
 * By default starts one shared multi-base kb-server for the whole batch; children attach
 * and select their `eval-{suite}` base per request. Pass `--per-suite-server` for the
 * legacy one-server-per-suite model.
 * @returns {Promise<{ suites: string[], parallel: number, results: object[], failed: string[], sharedServer: boolean }>}
 */
export async function runSuiteBatch(args, opts = {}) {
  const suites = resolveSuiteList(args)
  if (suites.length === 0) {
    throw new Error(
      `[eval] require --suite <vendor>, --suites a,b,…, or --all-suites (vendors: ${listSuiteIds().join(', ')})`
    )
  }
  assertMultiSuiteArgsOk(args, suites)
  const known = new Set(listSuiteIds())
  for (const id of suites) {
    if (!known.has(id)) {
      throw new Error(`[eval] unknown suite "${id}" (vendors: ${[...known].join(', ')})`)
    }
  }
  const parallel = resolveParallelism({
    suiteCount: suites.length,
    parallel: args.parallel,
    sequential: args.sequential,
    env: opts.env ?? process.env,
  })
  const sharedServer = !args.perSuiteServer
  console.error(
    `[eval] multi-suite batch · ${suites.length} suite(s) · concurrency ${parallel}${
      args.sequential ? ' (--sequential)' : parallel === suites.length ? ' (default parallel)' : ''
    } · server=${sharedServer ? 'shared multi-base' : 'per-suite ephemeral'}\n[eval] suites: ${suites.join(', ')}`
  )

  let shared = null
  let childEnv = opts.env ?? process.env
  if (sharedServer) {
    const defaultBase = derivedBase(suites[0])
    const batchStamp = dayjs().format('YYYY-MM-DD-HHmm')
    const batchLogDir = path.join(evaluationsRoot(), `_batch-${batchStamp}`)
    fs.mkdirSync(batchLogDir, { recursive: true })
    console.error(
      `[eval] starting shared multi-base kb-server (default base=${defaultBase}); children attach via X-KB-Base`
    )
    shared = await startEvalServer({
      base: defaultBase,
      apiKey: defaultEvalApiKey(),
      logPath: path.join(batchLogDir, 'eval-server.log'),
    })
    await shared.waitReady()
    childEnv = {
      ...(opts.env ?? process.env),
      KB_EVAL_SERVER_URL: shared.url,
      KB_EVAL_ATTACH_URL: shared.url,
      KB_SERVER_API_KEY: shared.apiKey,
    }
    console.error(`[eval] shared server ready at ${shared.url}`)
  }

  try {
    const results = await mapWithConcurrency(suites, parallel, suite =>
      spawnSuiteChild(suite, args, { ...opts, env: childEnv, sharedServer })
    )
    const failed = results.filter(r => r.code !== 0 || r.signal).map(r => r.suite)
    console.error(
      `[eval] multi-suite done · ok=${suites.length - failed.length} fail=${failed.length}${
        failed.length ? ` (${failed.join(', ')})` : ''
      }`
    )
    return { suites, parallel, results, failed, sharedServer }
  } finally {
    if (shared) {
      console.error('[eval] stopping shared multi-base kb-server')
      await shared.stop()
    }
  }
}

function parseArgs(argv) {
  // Accept optional legacy mode positional (init/all/query) for backward compat
  const legacyModes = new Set(['init', 'all', 'query'])
  const first = argv[2]
  const hasLegacyMode = first && !first.startsWith('-') && legacyModes.has(first)
  const out = {
    // init/all legacy → treat as --force-init; query legacy → no-op
    forceInit: first === 'init' || first === 'all',
    /** @type {string[]} */
    suites: [],
    allSuites: false,
    /** null = auto; 0 = all suites; >0 = cap */
    parallel: null,
    sequential: false,
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
    skipScan: false,
    perSuiteServer: false,
    autoScore: true, // on by default; disable with --manual-score
    autoScoreFile: null,
    scoreRuns: 3,
    // Query trials: run each question K times and average the per-axis scores across
    // trials to cancel run-to-run retrieval/judge nondeterminism (default 1 = off).
    queryTrials: Math.max(
      1,
      Number.parseInt(process.env.KB_EVAL_QUERY_TRIALS ?? '', 10) || 1
    ),
    // Control condition (the real-agent baseline) runs side-by-side with kb by default.
    skipControl: false,
    controlModel: null,
    controlMaxTurns: DEFAULT_MAX_TURNS,
    controlPrompt: process.env.KB_CONTROL_PROMPT || DEFAULT_CONTROL_PROMPT,
    controlAgent: process.env.KB_CONTROL_AGENT || 'claude',
    controlAgentCmd: process.env.KB_CONTROL_AGENT_CMD || null,
    queryTrace: false,
    help: false,
  }
  let i = hasLegacyMode ? 3 : 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--suite' || a === '--suites') {
      const next = argv[++i]
      if (!next || next.startsWith('--')) {
        throw new Error(`[eval] ${a} requires a suite id or comma-separated list`)
      }
      out.suites.push(...parseSuiteListToken(next))
    } else if (a === '--all-suites') out.allSuites = true
    else if (a === '--sequential') out.sequential = true
    else if (a === '--parallel') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--') && /^\d+$/.test(next)) {
        out.parallel = Math.max(1, Number.parseInt(argv[++i], 10) || 1)
      } else {
        // bare --parallel → run all suites concurrently
        out.parallel = 0
      }
    } else if (a === '--suite-yaml') out.suiteYaml = argv[++i]
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
    else if (a === '--query-trials' && argv[i + 1])
      out.queryTrials = Math.max(1, Number.parseInt(argv[++i], 10) || 1)
    else if (a === '--manual-score') out.autoScore = false
    else if (a === '--skip-init') out.skipCapture = true
    else if (a === '--skip-scan') out.skipScan = true
    else if (a === '--per-suite-server') out.perSuiteServer = true
    else if (a === '--force-init') out.forceInit = true
    else if (a === '--skip-control') out.skipControl = true
    else if (a === '--trace') out.queryTrace = true
    else if (a === '--control-model') out.controlModel = argv[++i]
    else if (a === '--control-max-turns')
      out.controlMaxTurns = Math.max(1, Number.parseInt(argv[++i], 10) || DEFAULT_MAX_TURNS)
    else if (a === '--control-prompt') out.controlPrompt = argv[++i]
    else if (a === '--control-agent') out.controlAgent = normalizeControlAgent(argv[++i])
    else if (a === '--control-agent-cmd') out.controlAgentCmd = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    i++
  }
  // Backward-compat alias used by single-suite path
  out.suite = out.suites.length === 1 ? out.suites[0] : out.suites[0] ?? null
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
  node scripts/eval-run.mjs --suites a,b,c [options]     # parallel by default
  node scripts/eval-run.mjs --all-suites [options]       # 10 benchmark suites, parallel
  npm run eval -- --suite raylib
  npm run eval -- --all-suites --control-agent cursor --control-model composer-2.5

Session lifecycle (automatic):
  Base is derived as eval-{suiteId} (e.g. eval-raylib, eval-kb).
  If the session has docs → reuse it (query-only run).
  If the session is empty / missing → kb init --git <snapshot-clone> first.
  Every run: kb scan (unless --skip-scan), then N× kb query (N = suite size).
  Multi-suite: one shared multi-base kb-server (override with --per-suite-server).
  Ends with a trends summary across prior runs for the same suite.

Suite / questions:
  --suite VENDOR          Load eval/suites/VENDOR.yaml  (also accepts comma lists)
  --suites a,b,c          Multiple suites (alias of repeated/comma --suite). Parallel by default.
  --all-suites            Run the 10 EVALUATION.md benchmark suites (excludes generic, moel-kb)
  --parallel [N]          Multi-suite concurrency (default: all suites at once; env KB_EVAL_PARALLEL)
                          Default: one shared multi-base kb-server; each child selects
                          eval-{suite} via --base / X-KB-Base.
  --sequential            Multi-suite: run one suite at a time (overrides --parallel)
  --per-suite-server      Legacy: one ephemeral kb-server process per suite child
  --suite-yaml PATH       Load pack from arbitrary YAML path (single-suite only)
  --questions-file F.json Override: JSON array of non-empty question strings (single-suite only)

Session:
  --base NAME             Override derived session name (default: eval-{suiteId}; single-suite only)
  --force-init            Delete the base, then kb init from scratch (not just scan)
  --skip-scan             Skip eval-index scan (reuse existing index; still queries). Forced scan
                          after a fresh init.

Target repo (for clone + git metadata):
  --repo URL              Override suite YAML repo_url (https or git@; single-suite only)
  --clone-branch BR
  --clone-depth N         Shallow depth (default 1; use 0 for full clone)

Output:
  --label SLUG            Stored as run_label in artifact
  --out PATH              Override artifact JSON path (single-suite only)
  --manual-score          Skip LLM auto-scoring (default: auto-score is ON)
  --score-runs N          Call scorer N times and average (reduces noise; default 3)
  --query-trials K        Run each question K times and average scores across trials to
                          cancel retrieval/judge nondeterminism (default 1; env KB_EVAL_QUERY_TRIALS)
  --scores-file PATH      Load manual rubric scores instead (JSON array, one per question)
  --auto-score-file PATH  Write auto-scores to a specific path

Control baseline (runs side-by-side with kb into ONE artifact, scored by the same rubric):
  --skip-control          Do NOT run the control; emit a kb-only artifact (control data omitted)
  --trace                 Pass kb query --trace so the server writes full retrieval dumps
                          under ~/.kb/traces/ (needed for discovery-vs-drop audits)
  --control-agent NAME    Built-in control agent: claude (default) or cursor (Cursor Agent CLI). Env: KB_CONTROL_AGENT
  --control-model NAME    Pin the control agent model (e.g. claude-opus-4-8, composer-2.5)
  --control-max-turns N   Per-question turn ceiling — claude only (default ${DEFAULT_MAX_TURNS})
  --control-prompt TEXT   Wrapper prompt for each control question ({{question}} placeholder). Env: KB_CONTROL_PROMPT
  --control-agent-cmd CMD Full override of --control-agent (prompt on stdin, JSON on stdout). Env: KB_CONTROL_AGENT_CMD

Advanced:
  --run-dir PATH          With --skip-init: reuse existing scratch dir (single-suite only)
  --skip-init             Skip all kb commands; re-score existing q*.json
  --hypothesis TEXT
  KB_EVAL_BIN=PATH        Drive a different kb.js (env). Lets these same scripts score a
                          main build vs a branch build for a fair before/after.
  KB_EVAL_PARALLEL=N      Default multi-suite concurrency when --parallel is omitted

Layout (per run, snapshot clone):
  ~/.kb/evaluations/<run-name>/<repo-name>/  git clone
  ~/.kb/evaluations/<run-name>/              scratch (q*.json, logs) + artifact.json
`)
}

/** kb subprocess env — offline for init/scan; remote after eval-server starts for queries. */
let kbSubprocessEnv = buildEvalOfflineEnv()

function kbEnv() {
  return kbSubprocessEnv
}

/** Stream eval-index (core init/scan) stdout/stderr live and write transcript to logPath. */
function evalIndexTee(mode, args, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, 'w')
  // `args` already contains shell-quoting around paths (e.g. --git "<path>"); it is built
  // internally, not from user input. Escaping those quotes turns them into literal `"`
  // characters in argv (git then fails on a path that literally contains quotes), so pass
  // the string through unescaped and let the shell consume the quotes as delimiters.
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

/**
 * Non-blocking `kb` (used to run independent queries concurrently). Returns stdout.
 * Retries transient failures (e.g. a query that times out under concurrent load) with
 * backoff so a single slow query does not abort a whole multi-trial harvest.
 */
async function kbAsync(cwd, args, { attempts = 3 } = {}) {
  const bin = KB_BIN
  let lastErr
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await execAsync(`node "${bin}" ${args}`, {
        encoding: 'utf8',
        env: kbEnv(),
        cwd,
        maxBuffer: 50 * 1024 * 1024,
      })
      return stdout
    } catch (err) {
      lastErr = err
      if (attempt < attempts) {
        const backoffMs = 2000 * 2 ** (attempt - 1)
        console.error(`[eval] query attempt ${attempt}/${attempts} failed; retrying in ${backoffMs}ms`)
        await new Promise(r => setTimeout(r, backoffMs))
      }
    }
  }
  throw lastErr
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving input
 * order in the returned results array. Used to parallelize independent eval
 * queries against kb-server without unbounded fan-out (which would trip provider
 * rate limits and overload the local server).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

/** Query concurrency for the harvest loop (bounded; default 4). Override with KB_EVAL_QUERY_CONCURRENCY. */
function evalQueryConcurrency() {
  const raw = Number(process.env.KB_EVAL_QUERY_CONCURRENCY)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return 4
}

const SCORE_AXES = ['correctness', 'usefulness', 'relevance', 'specificity', 'evidence_handling']

/**
 * Average per-axis score levels across query trials. Each trial's normalized scores may be
 * rubric labels or raw 0–4 levels; resolve both to levels, then mean them. Relevance falls
 * back to usefulness when a trial omits it (mirrors the single-run path). Output levels are
 * fractional on purpose — the whole point of trials is a less-noisy, finer-grained mean.
 */
function averageTrialScores(perTrialNormalized, count) {
  const trials = perTrialNormalized.length
  const out = []
  for (let i = 0; i < count; i++) {
    const acc = { correctness: 0, usefulness: 0, relevance: 0, specificity: 0, evidence_handling: 0 }
    let notes = ''
    for (let t = 0; t < trials; t++) {
      const ms = perTrialNormalized[t][i] ?? {}
      const usefulness = scoreFromLabel('usefulness', ms.usefulness)
      acc.correctness += scoreFromLabel('correctness', ms.correctness)
      acc.usefulness += usefulness
      acc.relevance += ms.relevance != null ? scoreFromLabel('relevance', ms.relevance) : usefulness
      acc.specificity += scoreFromLabel('specificity', ms.specificity)
      acc.evidence_handling += scoreFromLabel('evidence_handling', ms.evidence_handling)
      if (!notes && ms.notes?.trim()) notes = ms.notes.trim()
    }
    const avg = { notes: notes || `averaged over ${trials} query trials` }
    for (const axis of SCORE_AXES) avg[axis] = Number((acc[axis] / trials).toFixed(3))
    out.push(avg)
  }
  return out
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

/**
 * Returns true if the KB session already has an index (or at least one document).
 * Prefer the on-disk index check so a shared multi-base server holding SQLite open
 * does not race with an offline `docs list` before the query-phase server attach.
 */
function sessionHasDocs(targetCwd, base) {
  const kbHome = process.env.KB_HOME || path.join(os.homedir(), '.kb')
  if (fs.existsSync(path.join(kbHome, 'sessions', base, '.kb-index.sqlite'))) {
    return true
  }
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
function readKbQueryTelemetry(base, limit = 8, trials = 1) {
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
  // With K query trials there are limit×K recent reports; sum them all but divide the
  // totals by K so token/latency represent ONE representative run (trials are a measurement
  // device, not the product's cost — they must not K×-inflate the budgets).
  const t = Math.max(1, trials)
  const recent = reports.slice(-limit * t)
  const sum = key => recent.reduce((a, r) => a + (Number(r[key]) || 0), 0)
  return {
    questions_answered: Math.round(recent.length / t),
    total_input_tokens: Math.round(sum('totalInputTokens') / t),
    total_output_tokens: Math.round(sum('totalOutputTokens') / t),
    total_cost_usd: Number((sum('totalEstimatedCostUsd') / t).toFixed(4)),
    mean_num_turns: null,
    total_duration_ms: Math.round(sum('totalDurationMs') / t),
    // Most-recent one-trial slice of RunReports (one per question) so callers can build the
    // per-question timeline. Not summed — kept raw for stage + retrieval-trace inspection.
    per_question_reports: recent.slice(-limit),
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
  // Under concurrent harvest (esp. multi-trial) queries contend on the single kb-server and
  // can exceed the 60s default; give them more headroom (child procs inherit process.env).
  if (!process.env.KB_QUERY_TIMEOUT) process.env.KB_QUERY_TIMEOUT = '180s'
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  // Multi-suite batch: Node-native parallel children (default when >1 suite or --all-suites).
  const suiteList = resolveSuiteList(args)
  const multiSuite = args.allSuites || suiteList.length > 1
  if (multiSuite) {
    if (args.suiteYaml) {
      console.error('[eval] --suite-yaml cannot combine with --suites / --all-suites')
      process.exit(1)
    }
    try {
      const { failed } = await runSuiteBatch(args)
      process.exit(failed.length ? 1 : 0)
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    }
  }

  // Single-suite path: prefer first resolved id (supports --suite a,b when somehow length 1 after dedupe)
  if (suiteList.length === 1) args.suite = suiteList[0]

  if (args.suiteYaml && args.suite) {
    console.error('[eval] use only one of --suite and --suite-yaml')
    process.exit(1)
  }
  if (!args.suiteYaml && !args.suite) {
    console.error(
      `[eval] require --suite <vendor>, --suites a,b,…, --all-suites, or --suite-yaml <path.yaml> (vendors: ${listSuiteIds().join(', ')})`
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
  if (!fs.existsSync(path.join(KB_REPO, 'node_modules'))) {
    console.error('Missing node_modules — run: pnpm install (eval-index runs from this checkout, not the cloned target repo).')
    process.exit(1)
  }

  const runTiming = {
    commands: [],
    command_durations_ms: {},
    query_durations_ms: [],
    query_total_duration_ms: null,
  }

  let evalServer = null
  if (!args.skipCapture) {
    console.error(`[eval] suite=${suiteId} (${suiteLabel}) · base=${base} · mode=${evalMode}`)
    console.error(`[eval] workdir ${workdir}`)
    console.error(`[eval] target cwd ${targetCwd}`)
    const willScan = needsInit || !args.skipScan
    console.error(
      `[eval] session "${base}" — ${
        wipeBase
          ? 'force-init: deleting base then eval-index init + scan'
          : needsInit
            ? 'no docs found, running eval-index init then scan'
            : willScan
              ? 'reusing session; eval-index scan before K queries'
              : 'reusing session; --skip-scan (no index rebuild)'
      }`
    )

    kbSubprocessEnv = buildEvalOfflineEnv()

    try {
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
        console.error(`[eval] eval-index init --base ${base} --git "${targetCwd}"`)
        console.error(
          '[eval] eval-index clones snapshot into ~/.kb/sessions/… then indexes — progress lines follow'
        )
        await timedAsync('init', runTiming, () =>
          evalIndexTee(
            'init',
            `--base ${base} --git "${targetCwd}" --non-interactive --debug`,
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

      // Fresh init always scans once so the index exists; --skip-scan only skips reuse refresh.
      if (willScan) {
        console.error(`[eval] eval-index scan --base ${base}`)
        const scanLogPath = path.join(workdir, 'scan.log')
        await timedAsync('scan', runTiming, () =>
          evalIndexTee('scan', `--base ${base} --debug`, scanLogPath)
        )
      } else {
        runTiming.command_durations_ms.scan = 0
        fs.writeFileSync(
          path.join(workdir, 'scan.log'),
          `{"note":"skip_scan","base":"${base}"}\n`,
          'utf8'
        )
      }

      // Do NOT run `kb base use --default` here. It mutates the shared client
      // profile under ~/.kb and races under --all-suites parallel children
      // (banner shows the last writer). Queries already pass `--base` explicitly;
      // the shared multi-base server selects via X-KB-Base.

      const attaching =
        !!(process.env.KB_EVAL_SERVER_URL?.trim() || process.env.KB_EVAL_ATTACH_URL?.trim())
      console.error(
        attaching
          ? `[eval] attaching to shared multi-base kb-server for base=${base}`
          : '[eval] starting kb-server for remote queries (init/scan ran in-process)'
      )
      evalServer = await startEvalServer({
        base,
        logPath: path.join(workdir, 'eval-server.log'),
      })
      kbSubprocessEnv = evalServer.kbEnv()

      console.error(
        `[eval] waiting for kb-server index readiness (/healthz?base=${base} ok: true) before queries`
      )
      await evalServer.waitReady({ base })

      // docs/graph/logs after server attach so they hit the same multi-base process via --base
      // (avoids opening SQLite locally while the shared server holds the index).
      console.error('[eval] docs list')
      const docsOut = timed('docs_list', runTiming, () => kb(targetCwd, `docs list --base ${base}`))
      fs.writeFileSync(path.join(workdir, 'docs.txt'), docsOut, 'utf8')

      console.error('[eval] graph')
      const graphOut = timed('graph', runTiming, () => kb(targetCwd, `graph --base ${base}`))
      fs.writeFileSync(path.join(workdir, 'graph.txt'), graphOut, 'utf8')

      console.error('[eval] logs list')
      const logsOut = timed('logs_list', runTiming, () => kb(targetCwd, logsCmd(base)))
      fs.writeFileSync(path.join(workdir, 'logs.txt'), logsOut, 'utf8')

      // Queries are independent, so run them with bounded concurrency to cut wall-clock.
      // Order is preserved: results are written to q{n}.json by index, and per-question
      // durations land at their own index. Aggregate token/latency telemetry is summed
      // later from the NDJSON run reports (order-independent); per-question timeline
      // reports are matched in ask-order, which the in-order launch preserves.
      const concurrency = evalQueryConcurrency()
      const trials = args.queryTrials
      const wallStartMs = Date.now()
      runTiming.query_durations_ms = new Array(questions.length)
      runTiming.query_trials = trials
      let done = 0
      // One work item per (question, trial). Trial 1 of each question is the representative
      // answer stored as q{n}.json (and its duration is the per-question timing); every trial
      // is also written to q{n}.t{t}.json so scoring can average across trials.
      const work = []
      for (let idx = 0; idx < questions.length; idx++) {
        for (let t = 1; t <= trials; t++) work.push({ idx, t })
      }
      const total = work.length
      console.error(
        `[eval] ${suiteLabel} · running ${questions.length} K queries × ${trials} trial(s) = ${total} (concurrency ${concurrency})`
      )
      await mapWithConcurrency(work, concurrency, async ({ idx, t }) => {
        const q = idx + 1
        const escaped = questions[idx].replace(/"/g, '\\"')
        const label = `query_${q}_t${t}`
        const out = await timedAsync(label, runTiming, () =>
          kbAsync(
            targetCwd,
            `query "${escaped}" --base ${base}${args.queryTrace ? ' --trace' : ''}`
          )
        )
        const durationMs = runTiming.command_durations_ms[label]
        fs.writeFileSync(path.join(workdir, `q${q}.t${t}.json`), out, 'utf8')
        if (t === 1) {
          fs.writeFileSync(path.join(workdir, `q${q}.json`), out, 'utf8')
          runTiming.query_durations_ms[idx] = durationMs
        }
        done++
        console.error(
          `[eval] ${suiteLabel} · query ${q}/${questions.length} trial ${t}/${trials} done (${done}/${total}, ${durationMs}ms)`
        )
      })
      // Wall-clock of the parallel batch (not the summed per-query time) drives the run's
      // speed budget, so parallelism actually improves the reported speed sub-score.
      runTiming.query_total_duration_ms = Date.now() - wallStartMs
      fs.writeFileSync(path.join(workdir, 'runtime.json'), JSON.stringify(runTiming, null, 2), 'utf8')
    } finally {
      if (evalServer) {
        console.error('[eval] stopping kb-server')
        await evalServer.stop()
        evalServer = null
        kbSubprocessEnv = buildEvalOfflineEnv()
      }
    }
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
    // Trial averaging needs the per-trial answer files; a rescore-only path (--skip-init on
    // an old single-answer run) won't have them, so fall back to single-file scoring there.
    const trials =
      (args.queryTrials ?? 1) > 1 && fs.existsSync(path.join(workdir, 'q1.t1.json'))
        ? args.queryTrials
        : 1
    try {
      if (trials > 1) {
        // Score each query trial independently, then average the per-axis levels across
        // trials so run-to-run retrieval/judge noise cancels. Each trial's answers live in
        // q{n}.t{t}.json; score them from a per-trial view dir of q{n}.json files. The trials
        // are independent, so score them concurrently (bounded) rather than one at a time.
        for (let t = 1; t <= trials; t++) {
          const trialDir = path.join(workdir, `.score-t${t}`)
          fs.mkdirSync(trialDir, { recursive: true })
          for (let n = 1; n <= questions.length; n++) {
            fs.copyFileSync(
              path.join(workdir, `q${n}.t${t}.json`),
              path.join(trialDir, `q${n}.json`)
            )
          }
        }
        console.error(`[eval] auto-score ${trials} trials (concurrent)`)
        const trialResults = await mapWithConcurrency(
          Array.from({ length: trials }, (_, i) => i + 1),
          evalQueryConcurrency(),
          t => {
            const trialDir = path.join(workdir, `.score-t${t}`)
            return runAutoScoreFile({
              workdir: trialDir,
              questions,
              answers: suiteConfig?.answers ?? null,
              outScoresPath: path.join(trialDir, 'auto-scores.json'),
              rubricPhrase,
              scoreRuns: args.scoreRuns,
            })
          }
        )
        const perTrialNormalized = trialResults.map(r => r.normalized)
        const meta = trialResults[0]
        manualScores = averageTrialScores(perTrialNormalized, questions.length)
        fs.writeFileSync(outScores, JSON.stringify(manualScores, null, 2), 'utf8')
        queryScoringMeta = {
          mode: `llm_judge_avg_${args.scoreRuns}x_trials_${trials}`,
          provider: meta.providerUsed,
          model: meta.modelUsed,
          scores_file: outScores,
        }
      } else {
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
    // ms axes may be labels ("mostly_correct"), raw 0–4 levels, or fractional levels from
    // trial averaging. Resolve labels via scoreFromLabel, but preserve an already-finite
    // number (clamped, NOT rounded) so trial-averaged fractions survive into the means.
    const toLevel = (axis, v) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(4, Math.max(0, v))
        : scoreFromLabel(axis, v)
    const usefulness = ms ? toLevel('usefulness', ms.usefulness) : 0
    const scores = ms
      ? {
          correctness: toLevel('correctness', ms.correctness),
          usefulness,
          relevance: ms.relevance != null ? toLevel('relevance', ms.relevance) : usefulness,
          specificity: toLevel('specificity', ms.specificity),
          evidence_handling: toLevel('evidence_handling', ms.evidence_handling),
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
  const kbQueryTelemetryRaw = readKbQueryTelemetry(base, questions.length, args.queryTrials ?? 1)
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
        `kb-server start --base ${base} (eval orchestration)`,
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
