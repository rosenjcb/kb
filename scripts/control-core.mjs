/**
 * Control condition core: the real-agent baseline kb is measured against.
 *
 * Used as a phase inside `scripts/eval-run.mjs` (not a standalone command). For each
 * suite question it runs a REAL coding agent (Claude Code, headless) inside the same
 * repo clone the kb run used, with NO knowledge base (`--bare --strict-mcp-config`, so
 * no kb/MCP tools load). The agent explores raw files with its own Read/Grep/Glob/Bash
 * tools and answers — "what people do today". Answers are scored by the SAME rubric +
 * SAME judge as `kb query`. The result is returned as a `control` block that eval-run
 * folds into a single unified artifact next to the kb results, plus a `comparison`.
 *
 * This is the real, runnable form of the paper's "Condition N". The toy
 * eval/tools/filesystem-tools.ts baseline is legacy and not used here.
 *
 * Per-question comparison: `kb query "Q"` vs `claude -p "<prompt> Q"`. The prompt prefix
 * is configurable (--control-prompt / KB_CONTROL_PROMPT) and is deliberately easy to tune.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { buildCoverageAudit } from './eval-shared.mjs'
import { runAutoScoreFile } from './eval-score.mjs'

export const DEFAULT_CONTROL_PROMPT =
  'You are answering a question about the repository in the current working directory. ' +
  'Research the codebase using the available file/search tools, then give a thorough, ' +
  'concrete answer. Cite the specific files you relied on.\n\n{{question}}'

export const DEFAULT_MAX_TURNS = 30

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/** Default Claude Code headless argv. `--bare`/`--strict-mcp-config` guarantee no kb/MCP loads. */
export function defaultClaudeArgv({ model, maxTurns }) {
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

/** Human-readable description of the agent command (for logs / artifact). */
export function describeAgentCommand({ agentCmd, model, maxTurns }) {
  if (agentCmd) return agentCmd
  return ['claude', ...defaultClaudeArgv({ model, maxTurns })].join(' ')
}

/** Is a CLI available on PATH? */
export function commandAvailable(cmd) {
  try {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
  } catch {
    return false
  }
}

/** The agent binary the control phase will invoke (default: claude; else first token of agentCmd). */
export function controlAgentBinary(agentCmd) {
  if (!agentCmd) return 'claude'
  const m = String(agentCmd)
    .trim()
    .match(/^(\S+)/)
  return m ? m[1] : 'claude'
}

/**
 * Preflight: throw a clear, actionable error if the control phase cannot run.
 * Called early by eval-run.mjs so the whole eval fails fast (before any clone / kb init)
 * rather than doing all the kb work and only then discovering the agent is missing.
 */
export function assertControlAgentAvailable({
  agentCmd = null,
  controlPrompt = DEFAULT_CONTROL_PROMPT,
} = {}) {
  if (!controlPrompt.includes('{{question}}')) {
    throw new Error('control prompt must contain the {{question}} placeholder (--control-prompt)')
  }
  const bin = controlAgentBinary(agentCmd)
  if (!commandAvailable(bin)) {
    throw new Error(
      `control agent \`${bin}\` is not installed / not on PATH.
  The control baseline runs by default and needs a real coding agent.
  Fix one of:
    • install Claude Code (https://code.claude.com), or
    • re-run with --skip-control to evaluate kb only (control data omitted), or
    • pass --control-agent-cmd "<cmd>" (env KB_CONTROL_AGENT_CMD) to use another agent.`
    )
  }
}

/** Extract the trailing JSON object from agent stdout (tolerates a leading banner). */
export function extractJsonObject(text) {
  const i = text.indexOf('{')
  const j = text.lastIndexOf('}')
  if (i === -1 || j <= i) throw new Error('no JSON object in agent output')
  return JSON.parse(text.slice(i, j + 1))
}

/**
 * Run the control agent for one prompt inside repoDir. Returns the answer text and
 * normalized telemetry. Reads agent JSON from stdout; prompt is fed on stdin.
 */
export function runControlAgent({ repoDir, prompt, model, maxTurns, agentCmd }) {
  const res = agentCmd
    ? spawnSync('sh', ['-c', agentCmd], {
        cwd: repoDir,
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
    : spawnSync('claude', defaultClaudeArgv({ model, maxTurns }), {
        cwd: repoDir,
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
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
// Control pass → a `control` block (folded into the unified eval artifact)
// ---------------------------------------------------------------------------

/**
 * Run the control condition over a suite's questions and return a `control` block.
 * Writes per-question q*.json into `workdir` (control subdir) so the shared scorer can
 * read them. Throws only on fatal errors (missing agent binary, scorer failure);
 * per-question agent failures are recorded as empty answers and degrade status.
 *
 * @returns {Promise<object>} the control block (condition='control', aggregate_scores, …)
 */
export async function runControlPass({
  repoDir,
  workdir,
  suiteConfig,
  model = null,
  maxTurns = DEFAULT_MAX_TURNS,
  agentCmd = null,
  controlPrompt = DEFAULT_CONTROL_PROMPT,
  autoScore = true,
  scoreRuns = 1,
  scoresFile = null,
}) {
  assertControlAgentAvailable({ agentCmd, controlPrompt })

  const questions = suiteConfig.questions
  const agentName = agentCmd ? 'custom' : 'claude-code'
  const agentDesc = describeAgentCommand({ agentCmd, model, maxTurns })
  fs.mkdirSync(workdir, { recursive: true })
  console.error(`[control] agent ${agentDesc}`)

  // One agent call per question
  const perQuestion = []
  let q = 1
  for (const question of questions) {
    console.error(`[control] agent ${q}/${questions.length}`)
    const prompt = controlPrompt.replace('{{question}}', question)
    let answer = ''
    let telemetry = null
    try {
      const r = runControlAgent({ repoDir, prompt, model, maxTurns, agentCmd })
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
    fs.writeFileSync(
      path.join(workdir, `q${q}.json`),
      `${JSON.stringify(qfile, null, 2)}\n`,
      'utf8'
    )
    perQuestion.push(qfile)
    q++
  }

  // Score with the SAME rubric/judge as kb
  let scores = null
  let queryScoringMeta = null
  if (scoresFile) {
    scores = JSON.parse(fs.readFileSync(path.resolve(scoresFile), 'utf8'))
    if (!Array.isArray(scores) || scores.length !== questions.length) {
      throw new Error(`control --scores-file must be a JSON array of length ${questions.length}`)
    }
  } else if (autoScore) {
    const res = await runAutoScoreFile({
      workdir,
      questions,
      answers: suiteConfig.answers ?? null,
      outScoresPath: path.join(workdir, 'auto-scores.json'),
      rubricPhrase: suiteConfig.rubricPhrase,
      scoreRuns,
    })
    scores = res.normalized
    queryScoringMeta = {
      mode: scoreRuns > 1 ? `llm_judge_avg_${scoreRuns}` : 'llm_judge_single_shot',
      provider: res.providerUsed,
      model: res.modelUsed,
      scores_file: res.outScoresPath,
    }
  }

  const query_evaluation = perQuestion.map((qf, idx) => {
    const ms = scores?.[idx]
    const s = ms
      ? {
          correctness: Number(ms.correctness),
          usefulness: Number(ms.usefulness),
          specificity: Number(ms.specificity),
          evidence_handling: Number(ms.evidence_handling),
        }
      : { correctness: 0, usefulness: 0, specificity: 0, evidence_handling: 0 }
    return {
      question_id: idx + 1,
      question: questions[idx],
      result_count: 0,
      retrieval: qf.retrieval,
      answer_excerpt: qf.answer ? qf.answer.slice(0, 280) : null,
      provenance: [],
      coverage_audit: buildCoverageAudit(questions[idx], qf.answer, qf.retrieval.detail),
      control_telemetry: qf.telemetry,
      scores: s,
      notes: ms?.notes?.trim() ? ms.notes : 'control answer (no manual notes).',
    }
  })

  const agg = key => mean(query_evaluation.map(x => x.scores[key]))
  const passRate =
    query_evaluation.filter(x => x.scores.correctness >= 3 && x.scores.usefulness >= 3).length /
    query_evaluation.length
  const aggregateQuery = {
    mean_correctness: Number(agg('correctness').toFixed(3)),
    mean_usefulness: Number(agg('usefulness').toFixed(3)),
    mean_specificity: Number(agg('specificity').toFixed(3)),
    mean_evidence_handling: Number(agg('evidence_handling').toFixed(3)),
    pass_rate_correctness_and_usefulness_at_least_3: Number(passRate.toFixed(3)),
  }

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

  return {
    condition: 'control',
    status: tels.length === questions.length ? 'complete' : 'partial',
    agent: { name: agentName, model: model ?? 'default', command: agentDesc, max_turns: maxTurns },
    control_prompt: controlPrompt,
    query_scoring: queryScoringMeta,
    control_telemetry: controlTelemetry,
    // aggregate_scores mirrors the kb shape so shared scoreMetric()/trends work on this block.
    aggregate_scores: { query: aggregateQuery, combined: aggregateQuery },
    query_evaluation,
  }
}

/**
 * Head-to-head comparison between the kb aggregate_scores and the control block.
 * `kbAggregate` is the kb artifact's `aggregate_scores`; `control` is a control block.
 */
export function buildControlComparison(kbAggregate, control) {
  const k = kbAggregate?.query ?? {}
  const c = control?.aggregate_scores?.query ?? {}
  const delta = (a, b) =>
    typeof a === 'number' && typeof b === 'number' ? Number((a - b).toFixed(3)) : null
  const axis = key => ({
    kb: k[key] ?? null,
    control: c[key] ?? null,
    delta_kb_minus_control: delta(k[key], c[key]),
  })
  return {
    pass_rate: axis('pass_rate_correctness_and_usefulness_at_least_3'),
    mean_correctness: axis('mean_correctness'),
    mean_usefulness: axis('mean_usefulness'),
    mean_specificity: axis('mean_specificity'),
    mean_evidence_handling: axis('mean_evidence_handling'),
    control_efficiency: control?.control_telemetry ?? null,
  }
}
