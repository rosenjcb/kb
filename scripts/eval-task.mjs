#!/usr/bin/env node
/**
 * Task-execution eval: does having `kb` change how a real coding agent solves a real
 * GitHub issue, end to end (explore, edit, commit)? Complement to `scripts/eval-run.mjs`,
 * which scores `kb query` answer quality against a fixed question set — this script
 * instead runs the SAME task twice, in two isolated clones pinned to the same commit:
 *
 *   Arm K (kb):      Claude Code headless, kb's MCP tool + the kb:dev-workflow skill
 *                     content available, told to always pass the given `kb_base`.
 *   Arm N (control):  Claude Code headless, no MCP, no kb tools/skill — explores with
 *                     its own Read/Grep/Glob/Bash, same as scripts/control-core.mjs's
 *                     Condition N, but with Edit/Write/commit allowed since this is a
 *                     real coding task, not read-only Q&A.
 *
 * Both arms get the identical verbatim task prompt (an issue's title/body via `gh issue
 * view`, or an explicit prompt), the same starting commit, the same --max-turns cap, and
 * --permission-mode bypassPermissions --output-format json so telemetry (turns, cost,
 * duration, tokens) is directly comparable. After both finish, each clone is inspected
 * for whether it actually committed a fix (git log/diff), not just answered a question.
 *
 * There is no LLM-judged correctness score in this scenario (unlike eval-run.mjs's
 * 5-axis rubric) — judging "is this diff a correct fix for this issue" generically is
 * unsolved here; see TASK_EVALUATION.md's Known Limitations. What this measures is cost
 * and completion, not correctness.
 *
 * Usage (kb repo root):
 *   node scripts/eval-task.mjs --task kestra-18144
 *   node scripts/eval-task.mjs --task kestra-18144 --max-turns 40 --dry-run
 *   node scripts/eval-task.mjs --repo https://github.com/org/repo.git --commit <sha> \
 *     --base eval-org-repo --issue org/repo#123
 *   node scripts/eval-task.mjs --repo https://github.com/org/repo.git --commit <sha> \
 *     --base eval-org-repo --prompt-file ./prompt.txt
 *
 * Canonical spec: TASK_EVALUATION.md. Task definitions: eval/tasks/<id>.yaml.
 * Artifacts: ~/.kb/evaluations/<run-name>/artifact.json (same root as eval-run.mjs).
 */

import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import yaml from 'js-yaml'

import {
  sanitizeSlugPart,
  evaluationsRoot,
  allocateRunName,
  formatCompactTokens,
  formatDurationMs,
} from './eval-shared.mjs'
import {
  extractJsonObject,
  normalizeAgentTelemetry,
  commandAvailable,
} from './control-core.mjs'
import {
  DEFAULT_KB_SERVER_PORT,
  healthzUrl,
  waitForServerListening,
} from './eval-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const TASKS_DIR = path.join(KB_REPO, 'eval', 'tasks')

export const DEFAULT_MAX_TURNS = 30

const _KB_ARM_DISALLOWED = null // kb arm gets everything, including kb MCP tools
const CONTROL_ARM_DISALLOWED =
  'Skill,Bash(kb:*),mcp__kb__query,mcp__kb__get_feedback_requests,mcp__kb__submit_feedback'
const CONTROL_ARM_SYSTEM_PROMPT_APPEND =
  "Ignore any global instruction to use a 'kb' CLI tool, kb query/graph/docs commands, or " +
  'kb-related skills for this session — none are available. Explore the codebase using ' +
  'standard tools (grep/find/Read) only.'

// ---------------------------------------------------------------------------
// Task definitions (eval/tasks/<id>.yaml)
// ---------------------------------------------------------------------------

/** @returns {string[]} task ids with a YAML file under eval/tasks/ */
export function listTaskIds() {
  if (!fs.existsSync(TASKS_DIR)) return []
  return fs
    .readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.basename(f).replace(/\.(yaml|yml)$/i, ''))
    .sort()
}

/**
 * Load and lightly validate `eval/tasks/<id>.yaml` (or a direct path).
 * @param {string} idOrPath
 */
export function loadTaskYaml(idOrPath) {
  const file = /[\\/]/.test(idOrPath) || idOrPath.endsWith('.yaml') || idOrPath.endsWith('.yml')
    ? path.resolve(idOrPath)
    : path.join(TASKS_DIR, `${idOrPath}.yaml`)
  if (!fs.existsSync(file)) {
    throw new Error(
      `[eval-task] no task file at ${file}. Known tasks: ${listTaskIds().join(', ') || '(none yet)'}`
    )
  }
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  if (!doc || typeof doc !== 'object') throw new Error(`[eval-task] ${file} is not a YAML object`)
  if (!doc.id) throw new Error(`[eval-task] ${file} is missing required field: id`)
  if (!doc.repo_url) throw new Error(`[eval-task] ${file} is missing required field: repo_url`)
  if (!doc.issue && !doc.prompt) {
    throw new Error(`[eval-task] ${file} needs one of: issue (repo+number) or prompt`)
  }
  return { sourceFile: file, ...doc }
}

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

/**
 * Fetch an issue's title/body verbatim via `gh issue view` and build the task prompt.
 * Deliberately does not paraphrase or add implementation hints — see this project's own
 * lesson: an agent steered by a paraphrased prompt investigates differently than one
 * given the real ticket.
 * @param {{ repo: string, number: number|string }} issue
 */
export function resolveIssuePrompt({ repo, number }) {
  if (!commandAvailable('gh')) {
    throw new Error(
      '[eval-task] `gh` is not installed / not on PATH — required to fetch --issue text. ' +
        'Install https://cli.github.com, or use --prompt-file / a task YAML `prompt:` field instead.'
    )
  }
  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(number), '--repo', repo, '--json', 'title,body,url'],
    { encoding: 'utf8' }
  )
  const { title, body, url } = JSON.parse(raw)
  return [
    'Fix this GitHub issue in the repo. Here is the issue verbatim:',
    '',
    `Title: ${title}`,
    '',
    'Body:',
    body ?? '(no body)',
    '',
    `URL: ${url}`,
    '',
    'Find and fix the root cause in the codebase, then commit the fix with a clear commit message when done.',
  ].join('\n')
}

/** @param {object} task loaded via loadTaskYaml */
export function buildTaskPrompt(task) {
  if (task.prompt) return String(task.prompt).trim()
  return resolveIssuePrompt(task.issue)
}

// ---------------------------------------------------------------------------
// Isolated clones
// ---------------------------------------------------------------------------

/**
 * Clone `url` into `dest` and check out `commit` if given (else stay on the default
 * branch tip, recording the resolved commit). No `--depth`: an arbitrary pinned commit
 * may not be reachable from a shallow clone, and task-eval runs are infrequent enough
 * that clone time isn't the bottleneck `eval-run.mjs`'s suite clones optimize for.
 * @returns {string} the resolved commit sha actually checked out
 */
export function cloneAtCommit({ url, dest, commit, branch }) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const cloneArgs = ['clone']
  if (branch) cloneArgs.push('-b', branch)
  cloneArgs.push(url, dest)
  console.error(`[eval-task] git ${cloneArgs.join(' ')}`)
  const clone = spawnSync('git', cloneArgs, { stdio: 'inherit', encoding: 'utf8' })
  if (clone.error) throw clone.error
  if (clone.status !== 0) throw new Error(`git clone failed with status ${clone.status}`)
  if (commit) {
    const co = spawnSync('git', ['checkout', commit], { cwd: dest, stdio: 'inherit', encoding: 'utf8' })
    if (co.error) throw co.error
    if (co.status !== 0) throw new Error(`git checkout ${commit} failed with status ${co.status}`)
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim()
}

/** Isolate an arm's clone into its own branch so a commit never touches the source ref. */
export function branchOffCommit(dest, branchName) {
  const r = spawnSync('git', ['checkout', '-b', branchName], { cwd: dest, stdio: 'inherit', encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git checkout -b ${branchName} failed with status ${r.status}`)
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/** Skill content shipped at skills/kb:dev-workflow/SKILL.md, inlined so the kb arm works
 * without depending on the skill being separately installed in the environment running it. */
function loadDevWorkflowSkillBody() {
  const file = path.join(KB_REPO, 'skills', 'kb:dev-workflow', 'SKILL.md')
  const raw = fs.readFileSync(file, 'utf8')
  // Strip the YAML frontmatter — only the instructional body belongs in a system prompt.
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/**
 * @param {{ host: string, port: number, base: string, apiKey?: string }} server
 * @returns {string} JSON for --mcp-config
 */
function kbMcpConfigJson({ host, port, base, apiKey }) {
  const headers = { 'X-KB-Base': base }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return JSON.stringify({
    mcpServers: { kb: { type: 'http', url: `http://${host}:${port}/mcp`, headers } },
  })
}

export function buildKbArmArgv({ maxTurns, server }) {
  const argv = [
    '-p',
    '--append-system-prompt',
    `${loadDevWorkflowSkillBody()}\n\nWhenever you call the kb MCP tool, always pass base: '${server.base}' explicitly.`,
    '--mcp-config',
    kbMcpConfigJson(server),
    '--strict-mcp-config',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ]
  if (maxTurns) argv.push('--max-turns', String(maxTurns))
  return argv
}

export function buildControlArmArgv({ maxTurns }) {
  const argv = [
    '-p',
    '--append-system-prompt',
    CONTROL_ARM_SYSTEM_PROMPT_APPEND,
    '--disallowedTools',
    CONTROL_ARM_DISALLOWED,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ]
  if (maxTurns) argv.push('--max-turns', String(maxTurns))
  return argv
}

/** Run one arm's `claude -p` headless session inside `cwd`. Prompt is fed on stdin. */
export function runAgentArm({ cwd, prompt, argv, label }) {
  console.error(`[eval-task] ${label}: claude ${argv.filter(a => !a.includes('\n')).join(' ')} …`)
  const started = Date.now()
  const res = spawnSync('claude', argv, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  const wallMs = Date.now() - started
  if (res.error) throw res.error
  let json
  try {
    json = extractJsonObject(res.stdout || '')
  } catch (_e) {
    throw new Error(
      `[eval-task] ${label}: could not parse agent JSON output (exit ${res.status}): ${
        (res.stderr || '').slice(0, 500)
      }`
    )
  }
  return { telemetry: normalizeAgentTelemetry(json), wallMs, raw: json }
}

// ---------------------------------------------------------------------------
// Outcome inspection
// ---------------------------------------------------------------------------

/** Did the arm commit past `startCommit`? What changed, committed or not? */
export function inspectArmOutcome(dest, startCommit) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim()
  const committed = head !== startCommit
  const committedDiffStat = committed
    ? execFileSync('git', ['diff', '--stat', startCommit, head], { cwd: dest, encoding: 'utf8' }).trim()
    : null
  const uncommittedDiffStat = execFileSync('git', ['diff', '--stat'], { cwd: dest, encoding: 'utf8' }).trim()
  const uncommittedStatus = execFileSync('git', ['status', '--short'], { cwd: dest, encoding: 'utf8' }).trim()
  return {
    committed,
    head_commit: head,
    committed_diff_stat: committedDiffStat,
    uncommitted_diff_stat: uncommittedDiffStat || null,
    uncommitted_status: uncommittedStatus || null,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    task: null,
    repo: null,
    commit: null,
    branch: null,
    base: null,
    issue: null, // { repo, number }
    promptFile: null,
    maxTurns: null,
    runDir: null,
    outFile: null,
    dryRun: false,
    kbOnly: false,
    controlOnly: false,
    serverHost: process.env.KB_HOST || '127.0.0.1',
    serverPort: Number(process.env.KB_PORT) || DEFAULT_KB_SERVER_PORT,
    serverApiKey: process.env.KB_SERVER_API_KEY || null,
    help: false,
  }
  let i = 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--task') out.task = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--commit') out.commit = argv[++i]
    else if (a === '--clone-branch') out.branch = argv[++i]
    else if (a === '--base') out.base = argv[++i]
    else if (a === '--issue') {
      const m = /^([^#\s]+)#(\d+)$/.exec(argv[++i] ?? '')
      if (!m) throw new Error('[eval-task] --issue must look like owner/repo#123')
      out.issue = { repo: m[1], number: m[2] }
    } else if (a === '--prompt-file') out.promptFile = argv[++i]
    else if (a === '--max-turns') out.maxTurns = Number(argv[++i]) || null
    else if (a === '--run-dir') out.runDir = argv[++i]
    else if (a === '--out') out.outFile = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--kb-only') out.kbOnly = true
    else if (a === '--control-only') out.controlOnly = true
    else if (a === '--server-host') out.serverHost = argv[++i]
    else if (a === '--server-port') out.serverPort = Number(argv[++i])
    else if (a === '--server-api-key') out.serverApiKey = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`[eval-task] unknown flag: ${a}`)
    i++
  }
  if (out.kbOnly && out.controlOnly) {
    throw new Error('[eval-task] --kb-only and --control-only are mutually exclusive')
  }
  return out
}

function printHelp() {
  console.log(`
Task-execution eval: solve a real coding task twice (kb vs no-kb), compare cost/completion.

  node scripts/eval-task.mjs --task <id> [options]
  node scripts/eval-task.mjs --repo <url> --commit <sha> --base <kb-base> (--issue owner/repo#N | --prompt-file <path>) [options]

Options:
  --task <id>            Load eval/tasks/<id>.yaml (overrides individual flags below)
  --repo <url>            Git URL to clone
  --commit <sha>          Commit to pin both arms to (default: clone's default branch tip)
  --clone-branch <name>   Branch to clone before checking out --commit (default: repo default)
  --base <slug>           kb base the kb arm queries (e.g. eval-kestra)
  --issue owner/repo#N    Fetch the issue verbatim via \`gh issue view\` as the task prompt
  --prompt-file <path>    Use this file's contents as the verbatim task prompt instead
  --max-turns <n>         Cap per arm (default ${DEFAULT_MAX_TURNS}, same as control-core.mjs)
  --run-dir <path>        Override the run's working directory (default: allocated under ~/.kb/evaluations/)
  --out <path>            Override the artifact.json path
  --dry-run               Print the two claude invocations and exit without running them
  --kb-only               Skip the control (no-kb) arm
  --control-only          Skip the kb arm
  --server-host / --server-port / --server-api-key   Where the kb MCP server is (default 127.0.0.1:${DEFAULT_KB_SERVER_PORT})

Known tasks: ${listTaskIds().join(', ') || '(none yet — see eval/tasks/README.md)'}

Canonical spec: TASK_EVALUATION.md
`)
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }

  const task = args.task
    ? loadTaskYaml(args.task)
    : {
        id: args.repo ? sanitizeSlugPart(args.repo) : 'ad-hoc',
        repo_url: args.repo,
        commit: args.commit,
        kb_base: args.base,
        issue: args.issue,
        prompt: args.promptFile ? fs.readFileSync(path.resolve(args.promptFile), 'utf8') : null,
        max_turns: args.maxTurns,
      }
  if (!task.repo_url) throw new Error('[eval-task] no repo_url — pass --task or --repo')
  if (!task.kb_base) throw new Error('[eval-task] no kb_base — pass --task or --base')

  const maxTurns = args.maxTurns || task.max_turns || DEFAULT_MAX_TURNS
  const prompt = buildTaskPrompt(task)

  const server = { host: args.serverHost, port: args.serverPort, base: task.kb_base, apiKey: args.serverApiKey }

  if (args.dryRun) {
    console.log('--- kb arm ---')
    console.log('claude', buildKbArmArgv({ maxTurns, server }).map(a => (a.length > 120 ? `${a.slice(0, 120)}…` : a)).join(' '))
    console.log('\n--- control arm ---')
    console.log('claude', buildControlArmArgv({ maxTurns }).join(' '))
    console.log('\n--- prompt ---')
    console.log(prompt)
    return
  }

  if (!commandAvailable('claude')) {
    throw new Error('[eval-task] `claude` is not installed / not on PATH — install Claude Code (https://code.claude.com)')
  }
  if (!args.controlOnly) {
    await waitForServerListening(`http://${server.host}:${server.port}`, { base: server.base })
    const res = await fetch(healthzUrl(`http://${server.host}:${server.port}`, server.base))
    if (!res.ok) {
      throw new Error(
        `[eval-task] kb-server at ${server.host}:${server.port} is not healthy for base "${server.base}" ` +
          `(HTTP ${res.status}). Start it or pass --server-host/--server-port, or run --control-only.`
      )
    }
  }

  const runName = allocateRunName(task.id)
  const runDir = args.runDir ? path.resolve(args.runDir) : path.join(evaluationsRoot(), runName)
  fs.mkdirSync(runDir, { recursive: true })
  console.error(`[eval-task] run: ${runName} (${runDir})`)

  const kbDest = path.join(runDir, 'kb-arm')
  const controlDest = path.join(runDir, 'control-arm')

  let kbOutcome = null
  let controlOutcome = null
  let kbStartCommit = null
  let controlStartCommit = null

  if (!args.controlOnly) {
    kbStartCommit = cloneAtCommit({ url: task.repo_url, dest: kbDest, commit: task.commit, branch: args.branch })
    branchOffCommit(kbDest, `eval-task/kb/${runName}`)
    console.error(`[eval-task] kb arm: pinned at ${kbStartCommit}`)
    const { telemetry, wallMs, raw } = runAgentArm({
      cwd: kbDest,
      prompt,
      argv: buildKbArmArgv({ maxTurns, server }),
      label: 'kb arm',
    })
    kbOutcome = { ...inspectArmOutcome(kbDest, kbStartCommit), telemetry, wall_ms: wallMs, agent_result: raw }
    console.error(`[eval-task] kb arm: committed=${kbOutcome.committed} turns=${telemetry.num_turns} cost=$${telemetry.total_cost_usd}`)
  }

  if (!args.kbOnly) {
    controlStartCommit = cloneAtCommit({ url: task.repo_url, dest: controlDest, commit: task.commit, branch: args.branch })
    branchOffCommit(controlDest, `eval-task/control/${runName}`)
    console.error(`[eval-task] control arm: pinned at ${controlStartCommit}`)
    const { telemetry, wallMs, raw } = runAgentArm({
      cwd: controlDest,
      prompt,
      argv: buildControlArmArgv({ maxTurns }),
      label: 'control arm',
    })
    controlOutcome = { ...inspectArmOutcome(controlDest, controlStartCommit), telemetry, wall_ms: wallMs, agent_result: raw }
    console.error(`[eval-task] control arm: committed=${controlOutcome.committed} turns=${telemetry.num_turns} cost=$${telemetry.total_cost_usd}`)
  }

  const artifact = buildArtifact({ runName, task, maxTurns, prompt, kbOutcome, controlOutcome })
  const outFile = args.outFile ? path.resolve(args.outFile) : path.join(runDir, 'artifact.json')
  fs.writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.error(`[eval-task] artifact: ${outFile}`)

  printSummary(artifact)
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const TASK_ARTIFACT_SCHEMA_VERSION = 1

export function buildArtifact({ runName, task, maxTurns, prompt, kbOutcome, controlOutcome }) {
  const side = outcome =>
    outcome && {
      committed: outcome.committed,
      head_commit: outcome.head_commit,
      committed_diff_stat: outcome.committed_diff_stat,
      uncommitted_diff_stat: outcome.uncommitted_diff_stat,
      telemetry: outcome.telemetry,
      wall_ms: outcome.wall_ms,
    }
  const comparison =
    kbOutcome && controlOutcome
      ? {
          committed: { kb: kbOutcome.committed, control: controlOutcome.committed },
          num_turns: delta(kbOutcome.telemetry.num_turns, controlOutcome.telemetry.num_turns),
          total_cost_usd: delta(kbOutcome.telemetry.total_cost_usd, controlOutcome.telemetry.total_cost_usd),
          duration_ms: delta(kbOutcome.telemetry.duration_ms, controlOutcome.telemetry.duration_ms),
          output_tokens: delta(kbOutcome.telemetry.output_tokens, controlOutcome.telemetry.output_tokens),
        }
      : null
  return {
    schema_version: TASK_ARTIFACT_SCHEMA_VERSION,
    evaluation_plan: 'TASK_EVALUATION.md',
    run_label: runName,
    status: kbOutcome || controlOutcome ? 'complete' : 'partial',
    created_at: dayjs().toISOString(),
    task: {
      id: task.id,
      repo_url: task.repo_url,
      commit: task.commit ?? null,
      kb_base: task.kb_base,
      issue: task.issue ?? null,
      prompt,
      max_turns: maxTurns,
    },
    arms: {
      kb: side(kbOutcome),
      control: side(controlOutcome),
    },
    comparison,
  }
}

function delta(kb, control) {
  if (typeof kb !== 'number' || typeof control !== 'number') return null
  return { kb, control, delta_kb_minus_control: Number((kb - control).toFixed(4)) }
}

function printSummary(artifact) {
  const rows = []
  for (const [label, arm] of [['kb', artifact.arms.kb], ['control', artifact.arms.control]]) {
    if (!arm) continue
    rows.push(
      `  ${label.padEnd(8)} committed=${String(arm.committed).padEnd(5)} ` +
        `turns=${String(arm.telemetry.num_turns ?? '-').padEnd(4)} ` +
        `cost=$${String(arm.telemetry.total_cost_usd ?? '-').padEnd(8)} ` +
        `dur=${formatDurationMs(arm.telemetry.duration_ms).padEnd(6)} ` +
        `out_tok=${formatCompactTokens(arm.telemetry.output_tokens)}`
    )
  }
  console.log(`\n[eval-task] ${artifact.run_label} — ${artifact.task.id}`)
  console.log(rows.join('\n'))
  if (artifact.comparison) {
    const c = artifact.comparison
    console.log(
      `  Δ (kb − control): turns=${fmtDelta(c.num_turns)} cost=${fmtDelta(c.total_cost_usd)} ` +
        `duration_ms=${fmtDelta(c.duration_ms)} output_tokens=${fmtDelta(c.output_tokens)}`
    )
  }
  console.log('')
}

function fmtDelta(d) {
  if (!d) return '-'
  return d.delta_kb_minus_control
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch(e => {
    console.error(e instanceof Error ? e.stack || e.message : e)
    process.exit(1)
  })
}
