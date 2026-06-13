/**
 * Control condition core: the real-agent baseline kb is measured against.
 *
 * Used as a phase inside `scripts/eval-run.mjs` (not a standalone command). For each
 * suite question it runs a REAL coding agent (Claude Code, headless) inside the same
 * repo clone the kb run used, with NO knowledge base (`--strict-mcp-config`, so
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

import {
  buildCoverageAudit,
  computeSuccessScore,
  computeWeightedTokenTotal,
} from './eval-shared.mjs'
import { runAutoScoreFile } from './eval-score.mjs'

export const DEFAULT_CONTROL_PROMPT =
  'You are answering a question about the repository in the current working directory. ' +
  'Research the codebase using the available file/search tools, then give a thorough, ' +
  'concrete answer. Cite the specific files you relied on.\n\n{{question}}'

export const DEFAULT_MAX_TURNS = 30

/** Built-in control backends selectable via `--control-agent`. */
export const CONTROL_AGENT_CHOICES = ['claude', 'cursor']

export function normalizeControlAgent(name) {
  const v = String(name ?? 'claude')
    .trim()
    .toLowerCase()
  if (CONTROL_AGENT_CHOICES.includes(v)) return v
  throw new Error(
    `unknown --control-agent "${name}"; choose one of: ${CONTROL_AGENT_CHOICES.join(', ')}`
  )
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/** Default Claude Code headless argv. `--strict-mcp-config` guarantees no kb/MCP loads. */
export function defaultClaudeArgv({ model, maxTurns }) {
  const argv = [
    '-p',
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

/**
 * Default Cursor Agent CLI argv (`agent` binary). `--mode ask` is read-only Q&A;
 * `--trust` skips headless workspace prompts. No kb/MCP tools are injected by eval.
 */
export function defaultCursorArgv({ model }) {
  const argv = ['-p', '--output-format', 'json', '--mode', 'ask', '--trust']
  if (model) argv.push('--model', model)
  return argv
}

/** Human-readable description of the agent command (for logs / artifact). */
export function describeAgentCommand({ agentCmd, controlAgent = 'claude', model, maxTurns }) {
  if (agentCmd) return agentCmd
  if (controlAgent === 'cursor') {
    return ['agent', ...defaultCursorArgv({ model })].join(' ')
  }
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

/** The agent binary the control phase will invoke. */
export function controlAgentBinary({ agentCmd = null, controlAgent = 'claude' } = {}) {
  if (agentCmd) {
    const m = String(agentCmd)
      .trim()
      .match(/^(\S+)/)
    return m ? m[1] : 'claude'
  }
  return controlAgent === 'cursor' ? 'agent' : 'claude'
}

/**
 * Preflight: throw a clear, actionable error if the control phase cannot run.
 * Called early by eval-run.mjs so the whole eval fails fast (before any clone / kb init)
 * rather than doing all the kb work and only then discovering the agent is missing.
 */
export function assertControlAgentAvailable({
  agentCmd = null,
  controlAgent = 'claude',
  controlPrompt = DEFAULT_CONTROL_PROMPT,
} = {}) {
  if (!controlPrompt.includes('{{question}}')) {
    throw new Error('control prompt must contain the {{question}} placeholder (--control-prompt)')
  }
  const bin = controlAgentBinary({ agentCmd, controlAgent })
  if (!commandAvailable(bin)) {
    const installHint =
      controlAgent === 'cursor'
        ? 'install Cursor Agent CLI (`agent` on PATH; https://cursor.com/docs/agent/cli)'
        : 'install Claude Code (`claude` on PATH; https://code.claude.com)'
    throw new Error(
      `control agent \`${bin}\` is not installed / not on PATH.
  The control baseline runs by default and needs a real coding agent.
  Fix one of:
    • ${installHint}, or
    • re-run with --skip-control to evaluate kb only (control data omitted), or
    • pass --control-agent claude|cursor (env KB_CONTROL_AGENT), or
    • pass --control-agent-cmd "<cmd>" (env KB_CONTROL_AGENT_CMD) for a full override.`
    )
  }
}

/** One-line progress log after a control answer (tokens-first; turns/cost when present). */
export function formatControlAnswerLog(telemetry) {
  const parts = []
  const inTok = telemetry?.input_tokens
  const outTok = telemetry?.output_tokens
  if (typeof inTok === 'number' || typeof outTok === 'number') {
    parts.push(`in=${inTok ?? '?'} out=${outTok ?? '?'}`)
  }
  const cache = telemetry?.cache_read_tokens
  if (typeof cache === 'number' && cache > 0) parts.push(`cache=${cache}`)
  if (typeof telemetry?.num_turns === 'number') parts.push(`turns=${telemetry.num_turns}`)
  if (typeof telemetry?.total_cost_usd === 'number') {
    parts.push(`cost=$${telemetry.total_cost_usd.toFixed(4)}`)
  }
  if (typeof telemetry?.duration_ms === 'number') {
    const s = telemetry.duration_ms / 1000
    parts.push(s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`)
  }
  return parts.length ? parts.join(' ') : 'no telemetry'
}

/** Normalize agent JSON telemetry (Claude Code + Cursor Agent CLI shapes). */
export function normalizeAgentTelemetry(j) {
  const usage = j.usage ?? {}
  return {
    input_tokens: j.input_tokens ?? usage.input_tokens ?? usage.inputTokens ?? null,
    output_tokens: j.output_tokens ?? usage.output_tokens ?? usage.outputTokens ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? null,
    total_cost_usd: j.total_cost_usd ?? j.cost_usd ?? null,
    num_turns: j.num_turns ?? null,
    duration_ms: j.duration_ms ?? j.duration_api_ms ?? null,
    session_id: j.session_id ?? null,
    is_error: j.is_error ?? false,
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
export function runControlAgent({
  repoDir,
  prompt,
  model,
  maxTurns,
  agentCmd,
  controlAgent = 'claude',
}) {
  const spawnOpts = {
    cwd: repoDir,
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  }
  const res = agentCmd
    ? spawnSync('sh', ['-c', agentCmd], spawnOpts)
    : controlAgent === 'cursor'
      ? spawnSync('agent', defaultCursorArgv({ model }), spawnOpts)
      : spawnSync('claude', defaultClaudeArgv({ model, maxTurns }), spawnOpts)
  if (res.error) throw res.error
  if (res.status !== 0) {
    let detail = (res.stderr || '').slice(0, 800)
    if (!detail) {
      try {
        const j = extractJsonObject(res.stdout || '')
        detail = (j.result || j.error || JSON.stringify(j).slice(0, 200))
      } catch { /* ignore */ }
    }
    throw new Error(`control agent exited ${res.status}: ${detail}`)
  }
  const j = extractJsonObject(res.stdout || '')
  return {
    answer: typeof j.result === 'string' ? j.result : (j.text ?? ''),
    telemetry: normalizeAgentTelemetry(j),
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
  controlAgent = 'claude',
  controlPrompt = DEFAULT_CONTROL_PROMPT,
  autoScore = true,
  scoreRuns = 1,
  scoresFile = null,
}) {
  const backend = agentCmd ? null : normalizeControlAgent(controlAgent)
  assertControlAgentAvailable({ agentCmd, controlAgent: backend ?? 'claude', controlPrompt })

  const questions = suiteConfig.questions
  const agentName = agentCmd ? 'custom' : backend === 'cursor' ? 'cursor-agent' : 'claude-code'
  const agentDesc = describeAgentCommand({ agentCmd, controlAgent: backend ?? 'claude', model, maxTurns })
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
      const r = runControlAgent({
        repoDir,
        prompt,
        model,
        maxTurns,
        agentCmd,
        controlAgent: backend ?? 'claude',
      })
      answer = r.answer
      telemetry = r.telemetry
      console.error(`[control] answer ${formatControlAnswerLog(telemetry)}`)
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
    try {
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
    } catch (e) {
      console.error(`[control] auto-score failed (agent answers preserved, scores omitted): ${e instanceof Error ? e.message : e}`)
      queryScoringMeta = { mode: 'failed', error: e instanceof Error ? e.message : String(e) }
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

  const tels = perQuestion.map(qf => qf.telemetry).filter(Boolean)
  const answered = perQuestion.filter(qf => String(qf.answer ?? '').trim()).length
  const sum = key => tels.reduce((a, t) => a + (Number(t[key]) || 0), 0)
  const totalInputTokens = sum('input_tokens')
  const totalOutputTokens = sum('output_tokens')
  const totalCacheReadTokens = sum('cache_read_tokens')
  const totalWeightedTokens = tels.length
    ? tels.reduce(
        (acc, t) =>
          acc +
          computeWeightedTokenTotal({
            inputTokens: t.input_tokens,
            outputTokens: t.output_tokens,
            cacheReadTokens: t.cache_read_tokens,
          }),
        0
      )
    : null
  const controlTelemetry = {
    questions_answered: Math.max(tels.length, answered),
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cache_read_tokens: totalCacheReadTokens,
    total_weighted_tokens: totalWeightedTokens === null ? null : Math.round(totalWeightedTokens),
    total_cost_usd: Number(sum('total_cost_usd').toFixed(4)),
    mean_num_turns: tels.length ? Number((sum('num_turns') / tels.length).toFixed(2)) : null,
    total_duration_ms: sum('duration_ms'),
  }

  // Composite success score from the same formula kb uses (fair comparison).
  const mCorr = agg('correctness')
  const mUse = agg('usefulness')
  const controlSuccess = computeSuccessScore({
    meanCorrectness: mCorr,
    meanUsefulness: mUse,
    totalTokens: totalWeightedTokens,
    totalDurationMs: tels.length ? controlTelemetry.total_duration_ms : null,
  })
  const aggregateQuery = {
    success_score: controlSuccess.success_score,
    quality_score: controlSuccess.quality_score,
    token_efficiency: controlSuccess.token_efficiency,
    speed_score: controlSuccess.speed_score,
    mean_correctness: Number(mCorr.toFixed(3)),
    mean_usefulness: Number(mUse.toFixed(3)),
    mean_specificity: Number(agg('specificity').toFixed(3)),
    mean_evidence_handling: Number(agg('evidence_handling').toFixed(3)),
    pass_rate_correctness_and_usefulness_at_least_3: Number(passRate.toFixed(3)),
  }

  return {
    condition: 'control',
    status:
      answered === questions.length
        ? queryScoringMeta?.mode === 'failed'
          ? 'complete_unscored'
          : 'complete'
        : 'partial',
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
    success_score: axis('success_score'),
    token_efficiency: axis('token_efficiency'),
    speed_score: axis('speed_score'),
    pass_rate: axis('pass_rate_correctness_and_usefulness_at_least_3'),
    mean_correctness: axis('mean_correctness'),
    mean_usefulness: axis('mean_usefulness'),
    mean_specificity: axis('mean_specificity'),
    mean_evidence_handling: axis('mean_evidence_handling'),
    control_efficiency: control?.control_telemetry ?? null,
  }
}
