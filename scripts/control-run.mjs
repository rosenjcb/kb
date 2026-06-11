#!/usr/bin/env node
/**
 * Control eval harness: the baseline kb is measured against.
 *
 * Instead of `kb query`, this hands each suite question to a REAL coding agent
 * (Claude Code, headless) running inside a fresh clone of the target repo with
 * NO knowledge base. The agent explores the codebase with its own native tools
 * (Read/Grep/Glob/Bash) and answers — "what people do today". Answers are scored
 * by the SAME rubric + SAME judge as `kb query`, so the two artifacts compare
 * head-to-head (control vs kb). Per-question Claude Code telemetry (tokens, turns,
 * cost) is captured so the comparison covers efficiency as well as quality.
 *
 * This is the real, runnable form of the paper's "Condition N". The toy
 * eval/tools/filesystem-tools.ts baseline is legacy and not used here.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/control-run.mjs --suite raylib [--auto-score]
 *   node scripts/control-run.mjs --suite raylib --dry-run
 *   node scripts/control-run.mjs --suite raylib --model claude-opus-4-8
 *   node scripts/control-run.mjs --suite raylib --agent-cmd "cursor-agent -p --output-format json"
 *
 * Per-question comparison: `kb query "Q"` (kb artifact) vs `claude -p "<prompt> Q"`.
 * The prompt prefix is configurable (--control-prompt / KB_CONTROL_PROMPT) and is
 * deliberately easy to tune.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import yaml from 'js-yaml'

import {
  allocateRunName,
  buildCoverageAudit,
  evaluationsRoot,
  gitCloneSnapshot,
  listSuiteIds,
  loadVendorSuite,
  normalizeSuiteDoc,
  printTrendsSummary,
  repoLeafNameFromUrl,
} from './eval-shared.mjs'

import { runAutoScoreFile } from './eval-score.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')

const DEFAULT_CONTROL_PROMPT =
  'You are answering a question about the repository in the current working directory. ' +
  'Research the codebase using the available file/search tools, then give a thorough, ' +
  'concrete answer. Cite the specific files you relied on.\n\n{{question}}'

const DEFAULT_MAX_TURNS = 30

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    suite: null,
    suiteYaml: null,
    repo: null,
    cloneBranch: null,
    cloneDepth: 1,
    model: null,
    agentCmd: process.env.KB_CONTROL_AGENT_CMD || null,
    controlPrompt: process.env.KB_CONTROL_PROMPT || DEFAULT_CONTROL_PROMPT,
    maxTurns: DEFAULT_MAX_TURNS,
    autoScore: true,
    autoScoreFile: null,
    scoreRuns: 1,
    scoresFile: null,
    label: null,
    hypothesis: null,
    outFile: null,
    dryRun: false,
    help: false,
  }
  let i = 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--suite') out.suite = argv[++i]
    else if (a === '--suite-yaml') out.suiteYaml = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--clone-branch') out.cloneBranch = argv[++i]
    else if (a === '--clone-depth') out.cloneDepth = Number(argv[++i]) || 0
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--agent-cmd') out.agentCmd = argv[++i]
    else if (a === '--control-prompt') out.controlPrompt = argv[++i]
    else if (a === '--max-turns')
      out.maxTurns = Math.max(1, Number.parseInt(argv[++i], 10) || DEFAULT_MAX_TURNS)
    else if (a === '--manual-score') out.autoScore = false
    else if (a === '--auto-score') out.autoScore = true
    else if (a === '--score-runs' && argv[i + 1])
      out.scoreRuns = Math.max(1, Number.parseInt(argv[++i], 10) || 1)
    else if (a === '--scores-file') out.scoresFile = argv[++i]
    else if (a === '--auto-score-file') out.autoScoreFile = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--hypothesis') out.hypothesis = argv[++i]
    else if (a === '--out') out.outFile = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    i++
  }
  return out
}

function printHelp() {
  console.log(`control-run.mjs — control baseline (real agent, no kb) eval harness

  node scripts/control-run.mjs --suite <vendor-id> [options]
  pnpm run control -- --suite raylib --auto-score

The control answers the SAME suite questions as \`kb query\`, but via a real coding
agent (Claude Code headless) exploring a fresh clone with NO knowledge base. Scored
by the same rubric/judge → compare its artifact head-to-head against a kb run.

Suite / questions:
  --suite VENDOR          Load eval/suites/VENDOR.yaml  (${listSuiteIds().join(', ')})
  --suite-yaml PATH       Load pack from arbitrary YAML path

Target repo:
  --repo URL              Override suite YAML repo_url
  --clone-branch BR
  --clone-depth N         Shallow depth (default 1; 0 for full clone)

Control agent:
  --model NAME            Pin the agent model (e.g. claude-opus-4-8)
  --max-turns N           Per-question turn ceiling (default ${DEFAULT_MAX_TURNS})
  --control-prompt TEXT   Prompt template wrapping each question ({{question}} placeholder).
                          Env: KB_CONTROL_PROMPT.
  --agent-cmd "CMD"       Override the whole agent command (prompt fed on stdin; reads
                          JSON from stdout). Default is Claude Code headless. Env:
                          KB_CONTROL_AGENT_CMD. Example: "cursor-agent -p --output-format json".

Scoring / output:
  --auto-score            LLM auto-scoring (default ON; needs GEMINI_API_KEY or OPENAI_API_KEY)
  --manual-score          Skip auto-scoring
  --score-runs N          Average scorer over N calls (default 1)
  --scores-file PATH      Load manual rubric scores (JSON array)
  --label SLUG            run_label in artifact
  --out PATH              Override artifact path
  --dry-run               Print the plan + resolved agent command; run nothing

Layout: ~/.kb/evaluations/<run-name>/<repo-name>/ clone + artifact.json (condition=control)
`)
}

function loadSuiteFromPath(absPath) {
  const resolved = path.resolve(absPath)
  if (!fs.existsSync(resolved)) throw new Error(`[control] --suite-yaml not found: ${resolved}`)
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  return normalizeSuiteDoc(raw, resolved)
}

function git(repo, args) {
  try {
    return (
      spawnSync('git', args.split(' '), { encoding: 'utf8', cwd: repo }).stdout?.trim() || 'unknown'
    )
  } catch {
    return 'unknown'
  }
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/** Default Claude Code headless argv. `--bare`/`--strict-mcp-config` guarantee no kb/MCP loads. */
function defaultClaudeArgv({ model, maxTurns }) {
  const argv = [
    '-p',
    '--bare',
    '--strict-mcp-config',
    '--output-format',
    'json',
    '--allowedTools',
    'Read,Grep,Glob,Bash',
    '--disallowedTools',
    'Edit,Write',
  ]
  if (model) argv.push('--model', model)
  if (maxTurns) argv.push('--max-turns', String(maxTurns))
  return argv
}

/** Human-readable description of the agent command (for logs / dry-run / artifact). */
function describeAgentCommand({ agentCmd, model, maxTurns }) {
  if (agentCmd) return agentCmd
  return ['claude', ...defaultClaudeArgv({ model, maxTurns })].join(' ')
}

/** Extract the trailing JSON object from agent stdout (tolerates a leading banner). */
function extractJsonObject(text) {
  const i = text.indexOf('{')
  const j = text.lastIndexOf('}')
  if (i === -1 || j <= i) throw new Error('no JSON object in agent output')
  return JSON.parse(text.slice(i, j + 1))
}

/**
 * Run the control agent for one prompt inside repoDir. Returns the answer text and
 * normalized telemetry. Reads agent JSON from stdout; prompt is fed on stdin.
 */
function runControlAgent({ repoDir, prompt, model, maxTurns, agentCmd }) {
  let res
  if (agentCmd) {
    res = spawnSync('sh', ['-c', agentCmd], {
      cwd: repoDir,
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    })
  } else {
    res = spawnSync('claude', defaultClaudeArgv({ model, maxTurns }), {
      cwd: repoDir,
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    })
  }
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`control agent exited ${res.status}: ${(res.stderr || '').slice(0, 800)}`)
  }
  const j = extractJsonObject(res.stdout || '')
  const usage = j.usage ?? {}
  return {
    answer: typeof j.result === 'string' ? j.result : (j.text ?? ''),
    telemetry: {
      input_tokens: j.input_tokens ?? usage.input_tokens ?? null,
      output_tokens: j.output_tokens ?? usage.output_tokens ?? null,
      cache_read_tokens: usage.cache_read_input_tokens ?? null,
      total_cost_usd: j.total_cost_usd ?? j.cost_usd ?? null,
      num_turns: j.num_turns ?? null,
      duration_ms: j.duration_ms ?? null,
      session_id: j.session_id ?? null,
      is_error: j.is_error ?? false,
    },
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    process.exit(0)
  }
  if (args.suiteYaml && args.suite) {
    console.error('[control] use only one of --suite and --suite-yaml')
    process.exit(1)
  }
  if (!args.suiteYaml && !args.suite) {
    console.error(`[control] require --suite <vendor> (vendors: ${listSuiteIds().join(', ')})`)
    process.exit(1)
  }
  if (!args.controlPrompt.includes('{{question}}')) {
    console.error('[control] --control-prompt must contain the {{question}} placeholder')
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
  const repoUrl = args.repo || suiteConfig.repoUrl
  if (!repoUrl) {
    console.error('[control] require repo URL: pass --repo <git-url> or set repo_url in suite YAML')
    process.exit(1)
  }

  const questions = suiteConfig.questions
  const rubricPhrase = suiteConfig.rubricPhrase
  const agentDesc = describeAgentCommand({
    agentCmd: args.agentCmd,
    model: args.model,
    maxTurns: args.maxTurns,
  })
  const agentName = args.agentCmd ? 'custom' : 'claude-code'

  // Dry run: show the plan and exit before cloning or invoking the agent.
  if (args.dryRun) {
    const samplePrompt = args.controlPrompt.replace('{{question}}', questions[0])
    console.log(`[control] DRY RUN — suite=${suiteId} repo=${repoUrl}`)
    console.log(`[control] agent: ${agentDesc}`)
    console.log(`[control] questions: ${questions.length}`)
    console.log('[control] prompt for Q1 (stdin to the agent):')
    console.log('----------------------------------------')
    console.log(samplePrompt)
    console.log('----------------------------------------')
    console.log('[control] no clone, no agent calls, no scoring performed (dry run).')
    process.exit(0)
  }

  // Allocate run dir + clone
  const root = evaluationsRoot()
  const runName = allocateRunName(repoLeafNameFromUrl(repoUrl))
  const runDir = path.join(root, runName)
  const repoDir = path.join(runDir, repoLeafNameFromUrl(repoUrl))
  fs.mkdirSync(runDir, { recursive: true })
  gitCloneSnapshot({
    url: repoUrl,
    dest: repoDir,
    branch: args.cloneBranch || null,
    depth: args.cloneDepth,
  })

  console.error(`[control] run ${runName}`)
  console.error(`[control] repo clone ${repoDir}`)
  console.error(`[control] agent ${agentDesc}`)

  // Run the agent once per question
  const perQuestion = []
  let q = 1
  for (const question of questions) {
    console.error(`[control] agent ${q}/${questions.length}`)
    const prompt = args.controlPrompt.replace('{{question}}', question)
    let answer = ''
    let telemetry = null
    try {
      const r = runControlAgent({
        repoDir,
        prompt,
        model: args.model,
        maxTurns: args.maxTurns,
        agentCmd: args.agentCmd,
      })
      answer = r.answer
      telemetry = r.telemetry
      console.error(
        `[control] answer (${answer.length} chars, turns=${telemetry.num_turns ?? '?'}, cost=$${telemetry.total_cost_usd ?? '?'})`
      )
    } catch (e) {
      console.error(`[control] agent failed on Q${q}: ${e instanceof Error ? e.message : e}`)
    }
    const qfile = {
      __control__: true,
      answer,
      result_count: 0,
      provenance: [],
      retrieval: { method: 'control-agent', detail: agentName, confidence: null },
      telemetry,
    }
    fs.writeFileSync(path.join(runDir, `q${q}.json`), `${JSON.stringify(qfile, null, 2)}\n`, 'utf8')
    perQuestion.push(qfile)
    q++
  }

  // Score (same rubric/judge as kb)
  let manualScores = null
  let queryScoringMeta = null
  if (args.scoresFile) {
    manualScores = JSON.parse(fs.readFileSync(path.resolve(args.scoresFile), 'utf8'))
    if (!Array.isArray(manualScores) || manualScores.length !== questions.length) {
      console.error(`[control] --scores-file must be a JSON array of length ${questions.length}`)
      process.exit(1)
    }
  } else if (args.autoScore) {
    const outScores = args.autoScoreFile || path.join(runDir, 'auto-scores.json')
    try {
      const res = await runAutoScoreFile({
        workdir: runDir,
        questions,
        answers: suiteConfig.answers ?? null,
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

  // Build per-question evaluation + aggregate scores
  const query_evaluation = perQuestion.map((qf, idx) => {
    const coverageAudit = buildCoverageAudit(questions[idx], qf.answer, qf.retrieval.detail)
    const ms = manualScores?.[idx]
    const scores = ms
      ? {
          correctness: Number(ms.correctness),
          usefulness: Number(ms.usefulness),
          specificity: Number(ms.specificity),
          evidence_handling: Number(ms.evidence_handling),
        }
      : { correctness: 0, usefulness: 0, specificity: 0, evidence_handling: 0 }
    const notes = ms?.notes?.trim()
      ? ms.notes
      : 'Rubric scores not supplied — use --scores-file or --auto-score.'
    return {
      question_id: idx + 1,
      question: questions[idx],
      result_count: 0,
      retrieval: qf.retrieval,
      answer_excerpt: qf.answer ? qf.answer.slice(0, 280) : null,
      provenance: [],
      coverage_audit: coverageAudit,
      control_telemetry: qf.telemetry,
      scores,
      notes,
    }
  })

  const mC = mean(query_evaluation.map(x => x.scores.correctness))
  const mU = mean(query_evaluation.map(x => x.scores.usefulness))
  const mS = mean(query_evaluation.map(x => x.scores.specificity))
  const mE = mean(query_evaluation.map(x => x.scores.evidence_handling))
  const pr =
    query_evaluation.filter(x => x.scores.correctness >= 3 && x.scores.usefulness >= 3).length /
    query_evaluation.length

  // Aggregate control telemetry (the efficiency side of the comparison)
  const tels = perQuestion.map(qf => qf.telemetry).filter(Boolean)
  const sum = key => tels.reduce((a, t) => a + (Number(t[key]) || 0), 0)
  const controlTelemetry = {
    questions_answered: tels.length,
    total_input_tokens: sum('input_tokens'),
    total_output_tokens: sum('output_tokens'),
    total_cost_usd: Number(sum('total_cost_usd').toFixed(4)),
    mean_num_turns: tels.length ? Number((sum('num_turns') / tels.length).toFixed(2)) : null,
    total_duration_ms: sum('duration_ms'),
  }

  const branch = git(repoDir, 'branch --show-current')
  const commit = git(repoDir, 'rev-parse HEAD')
  const repoName = repoLeafNameFromUrl(repoUrl)
  const label = args.label || runName
  const status = tels.length === questions.length ? 'complete' : 'partial'

  const artifact = {
    schema_version: 1,
    evaluation_plan: 'EVALUATION.md',
    run_label: label,
    status,
    created_at: dayjs().toISOString(),
    repository: { name: repoName, branch, commit, clone_path: repoDir },
    hypothesis:
      args.hypothesis ||
      `Control baseline: real agent (${agentName}) answers suite=${suiteId} questions with NO kb. Compare vs a kb run.`,
    run: {
      base: null,
      condition: 'control',
      mode: 'control_agent',
      suite: suiteId,
      run_name: runName,
      evaluations_root: root,
      question_suite_file: path.relative(KB_REPO, suiteConfig.sourceFile).split(path.sep).join('/'),
      clone_url: repoUrl,
      target_cwd: repoDir,
      run_dir: runDir,
      publish_dir: null,
      agent: {
        name: agentName,
        model: args.model ?? 'default',
        command: agentDesc,
        max_turns: args.maxTurns,
      },
      control_prompt: args.controlPrompt,
      commands: [
        `git clone (snapshot) → ${repoDir}`,
        `${agentDesc}  (cwd: ${repoDir}, prompt on stdin, ${questions.length}×)`,
      ],
      control_telemetry: controlTelemetry,
      // No KB is built in the control condition; keep schema parity with kb runs.
      init_result: {
        status: 'not_run',
        written_docs: 0,
        written_doc_ids: [],
        init_run_id: null,
        init_run_id_note: 'control condition: no kb init (agent explores raw files).',
        docs_list: { count: 0 },
        graph_summary: { entities: 0, relationships: 0 },
      },
    },
    question_set: questions,
    query_scoring: queryScoringMeta,
    query_evaluation,
    chat_evaluation: { status: 'not_captured', notes: 'control harness: no kb chat.' },
    aggregate_scores: {
      query: {
        mean_correctness: Number(mC.toFixed(3)),
        mean_usefulness: Number(mU.toFixed(3)),
        mean_specificity: Number(mS.toFixed(3)),
        mean_evidence_handling: Number(mE.toFixed(3)),
        pass_rate_correctness_and_usefulness_at_least_3: Number(pr.toFixed(3)),
      },
      chat: {
        mean_correctness: 0,
        mean_usefulness: 0,
        mean_specificity: 0,
        mean_evidence_handling: 0,
        pass_rate_correctness_and_usefulness_at_least_3: 0,
      },
      combined: {
        mean_correctness: Number(mC.toFixed(3)),
        mean_usefulness: Number(mU.toFixed(3)),
        mean_specificity: Number(mS.toFixed(3)),
        mean_evidence_handling: Number(mE.toFixed(3)),
        pass_rate_correctness_and_usefulness_at_least_3: Number(pr.toFixed(3)),
      },
    },
    qualitative_findings: [
      queryScoringMeta
        ? `Scored by ${queryScoringMeta.provider} ${queryScoringMeta.model} (same rubric as kb runs).`
        : 'Scores unset — pass --auto-score or --scores-file.',
      `Control agent=${agentName} model=${args.model ?? 'default'}; no kb. Clone ${repoDir}.`,
      `Telemetry: in=${controlTelemetry.total_input_tokens} out=${controlTelemetry.total_output_tokens} cost=$${controlTelemetry.total_cost_usd} mean_turns=${controlTelemetry.mean_num_turns}`,
    ],
    next_improvement_areas: [
      'Run `pnpm run eval -- --suite <same>` for the kb side, then compare the two artifacts.',
    ],
  }

  const outPath = args.outFile || path.join(runDir, 'artifact.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.error(`[control] wrote ${outPath}`)

  printTrendsSummary(suiteId, KB_REPO)
}

const _isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (_isMain) {
  main().catch(err => {
    console.error(err instanceof Error ? err.stack || err.message : err)
    process.exit(1)
  })
}

export { parseArgs, extractJsonObject, defaultClaudeArgv, describeAgentCommand }
