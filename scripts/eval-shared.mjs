/**
 * Shared utilities used by both eval-run.mjs and moel-run.mjs.
 * Do not duplicate these in either script — import from here.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const SUITES_DIR = path.join(KB_REPO, 'eval', 'suites')

// ---------------------------------------------------------------------------
// Slug / naming helpers
// ---------------------------------------------------------------------------

export function sanitizeSlugPart(s) {
  const x = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return x || 'repo'
}

/** Short repo leaf name for artifact.repository.name (e.g. raylib). */
export function repoLeafNameFromUrl(url) {
  const raw = String(url)
    .trim()
    .replace(/\.git$/i, '')
  const scp = /^[\w.+-]+@[\w.-]+:[\w.-]+\/([\w.-]+)$/i.exec(raw)
  if (scp) return sanitizeSlugPart(scp[1])
  let href = raw
  if (!/^[\w+.-]+:/.test(href)) href = `https://${href}`
  try {
    const u = new URL(href)
    const segs = u.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
    if (segs.length) return sanitizeSlugPart(segs[segs.length - 1])
  } catch {
    /* */
  }
  return 'repo'
}

/** Strip the CLI banner prefix before the first `{` in output. */
export function stripCliBanner(text) {
  const i = text.indexOf('{')
  if (i === -1) return text.trim()
  return text.slice(i)
}

/** Deterministic session name from suite id: eval-{suiteId} */
export function derivedBase(suiteId) {
  return `eval-${sanitizeSlugPart(suiteId)}`
}

// ---------------------------------------------------------------------------
// Suite loading
// ---------------------------------------------------------------------------

export function evaluationsRoot() {
  return path.join(os.homedir(), '.kb', 'evaluations')
}

export function listSuiteIds() {
  if (!fs.existsSync(SUITES_DIR)) return []
  return fs
    .readdirSync(SUITES_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.basename(f).replace(/\.(yaml|yml)$/i, ''))
}

/**
 * Normalize a raw YAML suite object for eval-run.mjs.
 * @returns {{ id, questions, answers, rubricPhrase, sourceFile, repoUrl }}
 */
export function normalizeSuiteDoc(raw, sourceFile) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid suite YAML (not an object): ${sourceFile}`)
  }
  const qs = raw.questions
  if (!Array.isArray(qs) || qs.length === 0 || !qs.every(q => typeof q === 'string' && q.trim())) {
    throw new Error(`${sourceFile}: require questions: as a non-empty array of non-empty strings`)
  }
  const rubric = raw.rubric_focus
  if (typeof rubric !== 'string' || !rubric.trim()) {
    throw new Error(`${sourceFile}: require rubric_focus: non-empty string (LLM rubric context)`)
  }
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : path.basename(sourceFile).replace(/\.(yaml|yml)$/i, '')
  const repoUrl =
    typeof raw.repo_url === 'string' && raw.repo_url.trim() ? raw.repo_url.trim() : null

  let answers = null
  if (Array.isArray(raw.answers)) {
    if (raw.answers.length !== qs.length || !raw.answers.every(a => typeof a === 'string')) {
      throw new Error(
        `${sourceFile}: answers: must be an array of strings the same length as questions:`
      )
    }
    answers = raw.answers.map(a => a.trim())
  }

  const displayName =
    typeof raw.display_name === 'string' && raw.display_name.trim()
      ? raw.display_name.trim()
      : id

  return {
    id,
    displayName,
    questions: qs.map(s => s.trim()),
    answers,
    rubricPhrase: rubric.trim(),
    sourceFile,
    repoUrl,
    tasks: Array.isArray(raw.tasks) ? raw.tasks : null,
  }
}

/**
 * Normalize a raw YAML suite object for moel-run.mjs (relaxed: any question count).
 */
export function normalizeMoelSuiteDoc(raw, sourceFile) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid suite YAML (not an object): ${sourceFile}`)
  }
  const qs = raw.questions
  if (!Array.isArray(qs) || qs.length === 0 || !qs.every(q => typeof q === 'string' && q.trim())) {
    throw new Error(`${sourceFile}: require questions: as a non-empty array of strings`)
  }
  const rubric = raw.rubric_focus
  if (typeof rubric !== 'string' || !rubric.trim()) {
    throw new Error(`${sourceFile}: require rubric_focus: non-empty string`)
  }
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : path.basename(sourceFile).replace(/\.(yaml|yml)$/i, '')
  const repoUrl =
    typeof raw.repo_url === 'string' && raw.repo_url.trim() ? raw.repo_url.trim() : null

  let answers = null
  if (Array.isArray(raw.answers)) {
    answers = raw.answers.map(a => (typeof a === 'string' ? a.trim() : String(a)))
  }

  return {
    id,
    questions: qs.map(s => s.trim()),
    answers,
    rubricPhrase: rubric.trim(),
    sourceFile,
    repoUrl,
    tasks: Array.isArray(raw.tasks) ? raw.tasks : null,
  }
}

export function loadVendorSuite(suiteId) {
  const y = path.join(SUITES_DIR, `${suiteId}.yaml`)
  const y2 = path.join(SUITES_DIR, `${suiteId}.yml`)
  const file = fs.existsSync(y) ? y : fs.existsSync(y2) ? y2 : null
  if (!file) {
    const known = listSuiteIds()
    throw new Error(
      `[eval] unknown suite "${suiteId}". Files under eval/suites/: ${known.length ? known.join(', ') : '(none)'}`
    )
  }
  const raw = yaml.load(fs.readFileSync(file, 'utf8'))
  return normalizeSuiteDoc(raw, file)
}

export function loadMoelSuite(suiteId) {
  const y = path.join(SUITES_DIR, `${suiteId}.yaml`)
  const y2 = path.join(SUITES_DIR, `${suiteId}.yml`)
  const file = fs.existsSync(y) ? y : fs.existsSync(y2) ? y2 : null
  if (!file) {
    const known = listSuiteIds()
    throw new Error(
      `[moel] unknown suite "${suiteId}". Files under eval/suites/: ${known.length ? known.join(', ') : '(none)'}`
    )
  }
  const raw = yaml.load(fs.readFileSync(file, 'utf8'))
  return normalizeMoelSuiteDoc(raw, file)
}

// ---------------------------------------------------------------------------
// Query result parsing
// ---------------------------------------------------------------------------

/** Strip harness preamble / orchestration lines from direct (non chat-loop) query output. */
function extractDirectQueryAnswer(beforeSep) {
  const lines = beforeSep.split('\n')
  const kept = []
  let pastPreamble = false
  for (const line of lines) {
    if (!pastPreamble) {
      if (line.trim() === '') continue
      if (/^🤖 KB Agent/.test(line)) continue
      if (/^running intent /.test(line)) continue
      if (/^(stage|query)> /.test(line)) continue
      pastPreamble = true
    } else if (/^(stage|query)> /.test(line)) {
      continue
    }
    kept.push(line)
  }
  const answer = kept.join('\n').trim()
  return answer || null
}

/** Parse provenance ids from local CLI or remote-client query wire output. */
function parseQueryProvenance(text, answer) {
  const ids = new Set()

  const rankedInline =
    /^sources>\s*(?:top \d+ of \d+|all \d+) ranked:\s*(.+)$/m.exec(text)?.[1] ?? ''
  for (const part of rankedInline.split(';')) {
    const trimmed = part.trim()
    if (trimmed) ids.add(trimmed)
  }

  for (const line of text.split('\n')) {
    const sourceLine = /^source>\s*(.+)$/i.exec(line.trim())?.[1]?.trim()
    if (sourceLine) ids.add(sourceLine)
  }

  if (answer) {
    for (const match of answer.matchAll(/\((fact-[a-f0-9]{16})\)/gi)) {
      ids.add(match[1])
    }
  }

  return [...ids]
}

export function parseQueryText(text) {
  let answer = null
  const sepIdx = text.indexOf('\n---\n')
  if (sepIdx !== -1) {
    const beforeSep = text.slice(0, sepIdx)
    const lastDoneIdx = beforeSep.lastIndexOf('\nstage> answer')
    if (lastDoneIdx !== -1) {
      const lineEnd = beforeSep.indexOf('\n', lastDoneIdx + 1)
      if (lineEnd !== -1) answer = beforeSep.slice(lineEnd + 1).trim()
    } else {
      answer = extractDirectQueryAnswer(beforeSep)
    }
  }
  const retrievalLine = /^retrieval>\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null
  const method = /^(\w+)/.exec(retrievalLine ?? '')?.[1] ?? null
  const matchesCount = Number(/^matches>\s*(\d+)\s+ranked/m.exec(text)?.[1] ?? 0)
  const sourcesCount = Number(/^sources>\s*(\d+)\s*$/m.exec(text)?.[1] ?? 0)
  const resultCount = matchesCount || sourcesCount
  const provenance = parseQueryProvenance(text, answer)
  return {
    answer,
    result_count: resultCount,
    provenance,
    retrieval: { method, detail: retrievalLine, confidence: null },
  }
}

// ---------------------------------------------------------------------------
// Per-answer telemetry logging (K query RunReports + control agent JSON)
// ---------------------------------------------------------------------------

/**
 * One-line progress log after a kb query or control answer (tokens-first; turns/cost when present).
 * @param {{ input_tokens?: number|null, output_tokens?: number|null, cache_read_tokens?: number|null, num_turns?: number|null, total_cost_usd?: number|null, duration_ms?: number|null }|null|undefined} telemetry
 */
export function formatAnswerTelemetryLog(telemetry) {
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

/** Map a kb query RunReport to the shared answer-telemetry shape. */
export function runReportToAnswerTelemetry(report) {
  if (!report) return null
  return {
    input_tokens: Number.isFinite(Number(report.totalInputTokens)) ? Number(report.totalInputTokens) : null,
    output_tokens: Number.isFinite(Number(report.totalOutputTokens)) ? Number(report.totalOutputTokens) : null,
    cache_read_tokens: null,
    num_turns: null,
    total_cost_usd: Number.isFinite(Number(report.totalEstimatedCostUsd))
      ? Number(report.totalEstimatedCostUsd)
      : null,
    duration_ms: Number.isFinite(Number(report.totalDurationMs)) ? Number(report.totalDurationMs) : null,
  }
}

/**
 * Latest `query` RunReport for a base from ~/.kb/logs/*.jsonl.
 * @param {string} [base]
 * @param {{ minFinishedAtMs?: number }} [opts]
 */
export function readLatestKbQueryRunReport(base, { minFinishedAtMs } = {}) {
  const logsDir = path.join(os.homedir(), '.kb', 'logs')
  if (!fs.existsSync(logsDir)) return null
  let latest = null
  let latestTime = 0
  for (const file of fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const text = fs.readFileSync(path.join(logsDir, file), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.command !== 'query') continue
        if (base && r.base !== base) continue
        const t = new Date(r.finishedAt).getTime()
        if (!Number.isFinite(t)) continue
        if (typeof minFinishedAtMs === 'number' && t < minFinishedAtMs) continue
        if (t >= latestTime) {
          latestTime = t
          latest = r
        }
      } catch {
        /* skip malformed line */
      }
    }
  }
  return latest
}

export function parseGraphCounts(graphText) {
  const em = /Triplets:\s*(\d+)/.exec(graphText) ?? /Entities:\s*(\d+)/.exec(graphText)
  const rm = /Symbols:\s*(\d+)/.exec(graphText) ?? /Relationships:\s*(\d+)/.exec(graphText)
  return {
    entities: em ? Number(em[1]) : 0,
    relationships: rm ? Number(rm[1]) : 0,
  }
}

// ---------------------------------------------------------------------------
// Coverage audit
// ---------------------------------------------------------------------------

function deriveCoverageFacets(question) {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
  const stops = new Set([
    'about',
    'after',
    'again',
    'also',
    'another',
    'before',
    'between',
    'could',
    'does',
    'every',
    'first',
    'found',
    'given',
    'having',
    'hours',
    'large',
    'later',
    'might',
    'never',
    'often',
    'other',
    'place',
    'small',
    'since',
    'still',
    'their',
    'there',
    'these',
    'thing',
    'think',
    'those',
    'three',
    'under',
    'until',
    'using',
    'value',
    'which',
    'while',
    'whose',
    'would',
  ])
  return [...new Set(words.filter(w => !stops.has(w)))].slice(0, 8)
}

export function buildCoverageAudit(question, answer, retrievalDetail) {
  const facets = deriveCoverageFacets(question)
  if (facets.length === 0) {
    return { facets: [], missing_facets: [], covered_count: 0, coverage_ratio: 1 }
  }
  const haystack = `${answer || ''}\n${retrievalDetail || ''}`.toLowerCase()
  const missing = facets.filter(facet => !haystack.includes(facet))
  const covered = facets.length - missing.length
  return {
    facets,
    missing_facets: missing,
    covered_count: covered,
    coverage_ratio: Number((covered / facets.length).toFixed(3)),
  }
}

// ---------------------------------------------------------------------------
// Composite success score
// ---------------------------------------------------------------------------

/**
 * Weights for the composite success score (must sum to 1.0):
 *   - quality: mean correctness + usefulness (answer quality)
 *   - tokens:  total token economy (cheaper = better)
 *   - speed:   wall-clock latency (faster = better)
 */
export const SUCCESS_WEIGHTS = { quality: 0.6, tokens: 0.3, speed: 0.1 }

/**
 * Budget-absolute normalization references for an 8-question run. Both token and
 * speed sub-scores are `1 - min(total / budget, 1)`, so a run at the budget
 * scores 0 and a free/instant run scores 1. Tune these to recalibrate.
 */
export const SUCCESS_BUDGETS = { tokens: 1_000_000, timeMs: 600_000 }

/** Prompt-cache reads weighted at 0.1 (matches MOEL L_resource / Anthropic pricing). */
export const SUCCESS_TOKEN_CACHE_DISCOUNT = 0.1

/**
 * Adequacy threshold on the 0--4 rubric axes: scores below τ are penalized
 * linearly; marginal gain above τ is discounted by β (diminishing returns).
 */
export const ADEQUACY_THRESHOLD = 3
export const ADEQUACY_EXCELLENCE_BONUS = 0.2

const _clamp01 = n => Math.max(0, Math.min(1, n))
const _round3 = n => Number(n.toFixed(3))

/**
 * Per-axis adequacy utility φ(s) ∈ [0,1]. Maps rubric score s to a normalized
 * value where τ is "good enough" and excellence above τ earns only a β-fraction
 * of the remaining scale.
 *
 * @param {number} score
 * @param {number} [tau=ADEQUACY_THRESHOLD]
 * @param {number} [beta=ADEQUACY_EXCELLENCE_BONUS]
 */
export function adequacyUtility(score, tau = ADEQUACY_THRESHOLD, beta = ADEQUACY_EXCELLENCE_BONUS) {
  const s = Math.max(0, Math.min(4, Number(score) || 0))
  const linear = Math.min(s, tau) / tau
  const excess = (Math.max(0, s - tau) / (4 - tau)) * beta
  return _clamp01((linear + excess) / (1 + beta))
}

/**
 * Harvest adequacy quality Q ∈ [0,1]: mean of the per-axis adequacy utilities over the
 * quality axes. Correctness and usefulness are always included; **relevance** is folded in
 * when provided (a finite number), so an answer that drags in unrelated facts is penalized
 * even when it is correct and useful. Omitting `meanRelevance` preserves the original
 * two-axis behavior — required for back-compat with pre-relevance artifacts.
 */
export function computeAdequacyQuality(meanCorrectness, meanUsefulness, meanRelevance) {
  const axes = [meanCorrectness, meanUsefulness]
  if (typeof meanRelevance === 'number' && Number.isFinite(meanRelevance)) {
    axes.push(meanRelevance)
  }
  const sum = axes.reduce((s, a) => s + adequacyUtility(a), 0)
  return _round3(sum / axes.length)
}

/**
 * Weighted token footprint for success-score budgeting.
 * Control agents report fresh input, cache reads, and output separately; kb query
 * typically has no cache and passes only input+output (cacheReadTokens omitted).
 *
 * @param {{ inputTokens?: number|null, outputTokens?: number|null, cacheReadTokens?: number|null }} parts
 * @param {number} [cacheDiscount=SUCCESS_TOKEN_CACHE_DISCOUNT]
 */
export function computeWeightedTokenTotal(parts, cacheDiscount = SUCCESS_TOKEN_CACHE_DISCOUNT) {
  const fresh = Number(parts.inputTokens) || 0
  const cached = Number(parts.cacheReadTokens) || 0
  const output = Number(parts.outputTokens) || 0
  return fresh + cacheDiscount * cached + output
}

/**
 * Composite success score in [0,1] (higher = better). Quality uses adequacy
 * utilities on correctness and usefulness (τ=3 acceptable, β-discounted above);
 * token and speed sub-scores are budget-normalized.
 *
 * @param {{ meanCorrectness:number, meanUsefulness:number, totalTokens?:number|null, totalDurationMs?:number|null, inputTokens?:number|null, outputTokens?:number|null, cacheReadTokens?:number|null }} input
 */
export function computeSuccessScore(input, budgets = SUCCESS_BUDGETS, weights = SUCCESS_WEIGHTS) {
  const meanCorrectness = Number(input.meanCorrectness) || 0
  const meanUsefulness = Number(input.meanUsefulness) || 0
  const meanRelevance =
    typeof input.meanRelevance === 'number' && Number.isFinite(input.meanRelevance)
      ? input.meanRelevance
      : undefined
  const quality = computeAdequacyQuality(meanCorrectness, meanUsefulness, meanRelevance)

  const totalTokens =
    typeof input.totalTokens === 'number' && Number.isFinite(input.totalTokens)
      ? input.totalTokens
      : typeof input.inputTokens === 'number' ||
          typeof input.outputTokens === 'number' ||
          typeof input.cacheReadTokens === 'number'
        ? computeWeightedTokenTotal(input)
        : null
  const tokenEfficiency =
    typeof totalTokens === 'number' && Number.isFinite(totalTokens) && budgets.tokens > 0
      ? _clamp01(1 - Math.min(totalTokens / budgets.tokens, 1))
      : null

  const durationMs = input.totalDurationMs
  const speed =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && budgets.timeMs > 0
      ? _clamp01(1 - Math.min(durationMs / budgets.timeMs, 1))
      : null

  const success =
    tokenEfficiency === null || speed === null
      ? null
      : weights.quality * quality + weights.tokens * tokenEfficiency + weights.speed * speed

  return {
    success_score: success === null ? null : _round3(success),
    quality_score: _round3(quality),
    token_efficiency: tokenEfficiency === null ? null : _round3(tokenEfficiency),
    speed_score: speed === null ? null : _round3(speed),
    inputs: {
      mean_correctness: _round3(meanCorrectness),
      mean_usefulness: _round3(meanUsefulness),
      mean_relevance: meanRelevance === undefined ? null : _round3(meanRelevance),
      total_tokens: typeof totalTokens === 'number' ? Math.round(totalTokens) : null,
      total_cache_read_tokens:
        typeof input.cacheReadTokens === 'number' && Number.isFinite(input.cacheReadTokens)
          ? Math.round(input.cacheReadTokens)
          : null,
      total_duration_ms: typeof durationMs === 'number' ? durationMs : null,
      token_budget: budgets.tokens,
      time_budget_ms: budgets.timeMs,
    },
    weights,
  }
}

// ---------------------------------------------------------------------------
// Artifact metric accessors
// ---------------------------------------------------------------------------

/**
 * Parse the curator's out-of-band audit from a `retrieval>` detail line. The curator appends
 * `curated:kept=K,dropped=D,requeried=R,rounds=N` to `retrieval.detail`; this lifts those
 * numbers back out as a retrieval-side relevancy diagnostic (precision proxy for what reached
 * synthesis). Returns null when the line carries no curation segment (e.g. control runs).
 */
export function parseCurationDetail(detail) {
  if (typeof detail !== 'string') return null
  const m = /curated:kept=(\d+),dropped=(\d+),requeried=(\d+),rounds=(\d+)/.exec(detail)
  if (!m) return null
  return {
    kept: Number(m[1]),
    dropped: Number(m[2]),
    requeried: Number(m[3]),
    rounds: Number(m[4]),
  }
}

/**
 * Aggregate curator audits across a run's per-question retrieval details into a single
 * retrieval-relevancy summary. `precision` = kept / (kept + dropped) — higher means less
 * off-topic material survived into synthesis.
 */
export function summarizeCuration(retrievalDetails) {
  const stats = (retrievalDetails ?? []).map(parseCurationDetail).filter(Boolean)
  if (stats.length === 0) return null
  const kept = stats.reduce((a, s) => a + s.kept, 0)
  const dropped = stats.reduce((a, s) => a + s.dropped, 0)
  const denom = kept + dropped
  return {
    questions_with_curation: stats.length,
    total_kept: kept,
    total_dropped: dropped,
    total_requeried: stats.reduce((a, s) => a + s.requeried, 0),
    retrieval_precision: denom > 0 ? Number((kept / denom).toFixed(3)) : null,
    mean_drop_fraction: denom > 0 ? Number((dropped / denom).toFixed(3)) : null,
  }
}

// ---------------------------------------------------------------------------
// Per-question run timeline
//
// The headline scores say *whether* kb won; the timeline says *where a query
// spent its budget* — how many tokens went to the retrieval/judge loop
// ("thinking") vs the one-shot synthesis, how long each took, how many passes
// and graph hops ran, and how many facts the curator kicked out. This is the
// signal a cloud task session needs to answer "why are we slow / heavy now?".
// ---------------------------------------------------------------------------

/**
 * Parse the deep-loop counters from a `retrieval>` detail string
 * (`facts-loop;passes:3;graph_hops:5;ponds:2;stop:llm_judge_answerable;facts:24;...`).
 * Used as a fallback for older logs that predate the structured `report.retrieval` field.
 * Returns null when the string carries no `facts-loop` counters.
 */
export function parseRetrievalDetailTrace(detail) {
  if (typeof detail !== 'string' || !detail.includes('facts-loop')) return null
  const num = re => {
    const m = re.exec(detail)
    return m ? Number(m[1]) : null
  }
  const stop = /(?:^|[;\s(])stop:([^;)\s]+)/.exec(detail)
  const curation = parseCurationDetail(detail)
  return {
    passes: num(/(?:^|[;\s(])passes:(\d+)/),
    graph_hops: num(/(?:^|[;\s(])graph_hops:(\d+)/),
    ponds: num(/(?:^|[;\s(])ponds:(\d+)/),
    stop_reason: stop ? stop[1] : null,
    facts_returned: num(/(?:^|[;\s(])facts:(\d+)/),
    curation: curation
      ? { ...curation, dropped_fact_ids: [] }
      : null,
    hops: [],
    checkpoints: [],
  }
}

/**
 * Split a query RunReport's stages by role, summing tokens and duration for each:
 *   - **synthesis** — the one-shot answer stage (`*:answer-enrichment`).
 *   - **thinking** — the intent-loop LLM tokens (`*:llm`): rewrite, entity extraction,
 *     sufficiency judge, curator. This stage is logged with `durationMs: 0` (tokens are
 *     flushed into it), so it carries token cost but no wall-time.
 *   - **retrieval** — the deep-loop iteration stages (`*:iterN`, emitted by the intent loop),
 *     which carry the loop's *wall-time* but ~no tokens. This is where a query that grinds to
 *     `weak_evidence_after_exhaustion` actually spends its seconds.
 *   - **other** — anything else.
 * The caller derives `retrieval_ms` from `retrieval_ms` here (loop stages), falling back to
 * `total − synthesis − other` only for older logs that predate the per-iter stages.
 */
export function classifyStageTokens(report) {
  const acc = {
    thinking_tokens: 0,
    thinking_ms: 0,
    synthesis_tokens: 0,
    synthesis_ms: 0,
    retrieval_tokens: 0,
    retrieval_ms: 0,
    other_tokens: 0,
    other_ms: 0,
  }
  for (const s of report?.stages ?? []) {
    const tokens = (Number(s.inputTokens) || 0) + (Number(s.outputTokens) || 0)
    const ms = Number(s.durationMs) || 0
    if (/:answer-enrichment$/.test(s.stage)) {
      acc.synthesis_tokens += tokens
      acc.synthesis_ms += ms
    } else if (/:iter\d+$/.test(s.stage)) {
      acc.retrieval_tokens += tokens
      acc.retrieval_ms += ms
    } else if (/:llm$/.test(s.stage)) {
      acc.thinking_tokens += tokens
      acc.thinking_ms += ms
    } else {
      acc.other_tokens += tokens
      acc.other_ms += ms
    }
  }
  return acc
}

/** Normalize the structured `report.retrieval` trace (or a detail-string fallback) to one shape. */
function normalizeRetrievalTrace(report, fallbackDetail) {
  const r = report?.retrieval
  if (r && typeof r === 'object') {
    return {
      method: r.method ?? null,
      passes: r.passes ?? null,
      graph_hops: r.graphHops ?? null,
      ponds: r.ponds ?? null,
      stop_reason: r.stopReason ?? null,
      facts_returned: r.factsReturned ?? null,
      hops: Array.isArray(r.hops) ? r.hops : [],
      checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints : [],
      curation: r.curation
        ? {
            kept: r.curation.kept ?? null,
            dropped: r.curation.dropped ?? null,
            requeried: r.curation.requeried ?? null,
            rounds: r.curation.rounds ?? null,
            sufficient: r.curation.sufficient ?? null,
            dropped_fact_ids: Array.isArray(r.curation.droppedFactIds)
              ? r.curation.droppedFactIds
              : [],
          }
        : null,
    }
  }
  return parseRetrievalDetailTrace(fallbackDetail)
}

/**
 * Build one question's slice of the run timeline by joining its telemetry RunReport (stage
 * token/time split) with its retrieval trace (passes, hops, curator drops). `fallbackDetail`
 * is the parsed `retrieval.detail` text, used only when the report predates `report.retrieval`.
 */
export function buildQuestionTimeline(report, questionIndex, question, fallbackDetail) {
  const stages = classifyStageTokens(report)
  const totalMs = Number(report?.totalDurationMs) || 0
  // Retrieval wall-time is the sum of the loop's `:iterN` stages. Older logs predate those
  // stages, so fall back to "everything not synthesis/other" there.
  const retrievalMs =
    stages.retrieval_ms > 0
      ? stages.retrieval_ms
      : Math.max(0, totalMs - stages.synthesis_ms - stages.other_ms)
  const queryTokens =
    stages.thinking_tokens + stages.synthesis_tokens + stages.retrieval_tokens + stages.other_tokens
  const share = n => (queryTokens > 0 ? Number((n / queryTokens).toFixed(3)) : null)
  return {
    question_index: questionIndex,
    question: question ?? null,
    total_duration_ms: totalMs,
    total_input_tokens: Number(report?.totalInputTokens) || 0,
    total_output_tokens: Number(report?.totalOutputTokens) || 0,
    cost_usd: report?.totalEstimatedCostUsd != null ? Number(report.totalEstimatedCostUsd) : null,
    tokens: {
      thinking: stages.thinking_tokens,
      synthesis: stages.synthesis_tokens,
      other: stages.other_tokens,
    },
    token_share: {
      thinking: share(stages.thinking_tokens),
      synthesis: share(stages.synthesis_tokens),
    },
    timing: {
      total_ms: totalMs,
      synthesis_ms: stages.synthesis_ms,
      retrieval_ms: retrievalMs,
      other_ms: stages.other_ms,
    },
    retrieval: normalizeRetrievalTrace(report, fallbackDetail),
    stages: (report?.stages ?? []).map(s => ({
      stage: s.stage,
      duration_ms: Number(s.durationMs) || 0,
      input_tokens: Number(s.inputTokens) || 0,
      output_tokens: Number(s.outputTokens) || 0,
    })),
  }
}

/**
 * Aggregate a run's per-question timelines into a single diagnostic block: mean token/time
 * splits, where the budget goes (thinking vs synthesis share), curator drop rate, and the
 * outlier questions. `diagnosis[]` are plain-language flags a task session can act on directly.
 */
export function buildTimelineSummary(timeline) {
  const rows = Array.isArray(timeline) ? timeline : []
  if (rows.length === 0) return null

  const meanOf = fn => {
    const vals = rows.map(fn).filter(v => typeof v === 'number' && !Number.isNaN(v))
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null
  }
  const sumOf = fn => rows.reduce((a, r) => a + (Number(fn(r)) || 0), 0)
  const round = (n, d = 3) => (n == null ? null : Number(Number(n).toFixed(d)))

  const totalThinking = sumOf(r => r.tokens?.thinking)
  const totalSynthesis = sumOf(r => r.tokens?.synthesis)
  const totalOther = sumOf(r => r.tokens?.other)
  const totalQueryTokens = totalThinking + totalSynthesis + totalOther
  const totalRetrievalMs = sumOf(r => r.timing?.retrieval_ms)
  const totalMs = sumOf(r => r.timing?.total_ms)
  const totalDropped = sumOf(r => r.retrieval?.curation?.dropped)
  const totalKept = sumOf(r => r.retrieval?.curation?.kept)
  const curatorDenom = totalKept + totalDropped

  const byDuration = [...rows].sort((a, b) => (b.total_duration_ms || 0) - (a.total_duration_ms || 0))
  const byThinking = [...rows].sort((a, b) => (b.tokens?.thinking || 0) - (a.tokens?.thinking || 0))

  const thinkingShare = totalQueryTokens > 0 ? totalThinking / totalQueryTokens : null
  const synthesisShare = totalQueryTokens > 0 ? totalSynthesis / totalQueryTokens : null
  const retrievalTimeShare = totalMs > 0 ? totalRetrievalMs / totalMs : null

  // Loops that never satisfy the sufficiency judge run to exhaustion — the dominant slowness /
  // token-bloat driver, since they accumulate the largest fact pools and (when the curator
  // can't prune them) dump those pools into synthesis.
  const EXHAUSTION_STOPS = new Set(['weak_evidence_after_exhaustion', 'frontier_exhausted'])
  const exhausted = rows.filter(r => EXHAUSTION_STOPS.has(r.retrieval?.stop_reason))
  const exhaustionRate = rows.length > 0 ? exhausted.length / rows.length : null
  // What actually reaches synthesis is the *post-curation* count (curator `kept`), not the
  // orchestrator's raw pool. When curation didn't run/record, the raw pool is what flowed
  // through — which is exactly the fallback pathology, so `facts_returned` is the right value
  // there. This makes the metric move when the curator starts pruning (or stops falling back).
  const factsToSynthesis = r =>
    r.retrieval?.curation?.kept != null ? r.retrieval.curation.kept : r.retrieval?.facts_returned
  const meanFactsToSynthesis = meanOf(factsToSynthesis)
  // Curator "fell back": pool was large enough to curate (>12) but no curation record survived,
  // meaning the judge failed/parsed-empty and the full pool reached synthesis unpruned.
  const curatorFallbacks = rows.filter(
    r => (r.retrieval?.facts_returned ?? 0) > 12 && r.retrieval?.curation == null
  )

  const diagnosis = []
  if (thinkingShare != null && thinkingShare >= 0.5) {
    diagnosis.push(
      `Thinking (retrieval/judge loop) is ${(thinkingShare * 100).toFixed(0)}% of query tokens vs ${((synthesisShare ?? 0) * 100).toFixed(0)}% synthesis — the loop dominates token cost.`
    )
  }
  if (retrievalTimeShare != null && retrievalTimeShare >= 0.5) {
    diagnosis.push(
      `Retrieval loop wall-time is ${(retrievalTimeShare * 100).toFixed(0)}% of total — the hops, not synthesis, are the slowness.`
    )
  }
  if (exhaustionRate != null && exhaustionRate >= 0.34) {
    diagnosis.push(
      `${exhausted.length}/${rows.length} questions ran the loop to exhaustion (sufficiency judge never confirmed) — the early-exit is the lever for both speed and tokens.`
    )
  }
  const meanPasses = meanOf(r => r.retrieval?.passes)
  if (meanPasses != null && meanPasses >= 8) {
    diagnosis.push(
      `Mean ${meanPasses.toFixed(1)} loop passes/question — the sufficiency judge is exiting late; consider tighter early-exit.`
    )
  }
  if (curatorFallbacks.length > 0) {
    diagnosis.push(
      `Curator fell back on ${curatorFallbacks.length} question(s) (Q${curatorFallbacks
        .map(r => r.question_index)
        .join(', Q')}) — the full unpruned pool reached synthesis exactly where it was largest.`
    )
  }
  if (meanFactsToSynthesis != null && meanFactsToSynthesis >= 60) {
    diagnosis.push(
      `Mean ${Math.round(meanFactsToSynthesis)} facts reached synthesis (post-curation) — large evidence pools inflate synthesis input tokens.`
    )
  }
  if (curatorDenom > 0 && totalDropped / curatorDenom < 0.15) {
    diagnosis.push(
      `Curator dropped only ${((totalDropped / curatorDenom) * 100).toFixed(0)}% of facts — little pruning; large prompts reach synthesis.`
    )
  }
  if (diagnosis.length === 0) {
    diagnosis.push('No dominant cost concentration detected across the run timeline.')
  }

  return {
    questions: rows.length,
    mean_total_duration_ms: round(meanOf(r => r.total_duration_ms), 0),
    mean_thinking_tokens: round(meanOf(r => r.tokens?.thinking), 0),
    mean_synthesis_tokens: round(meanOf(r => r.tokens?.synthesis), 0),
    thinking_token_share: round(thinkingShare),
    synthesis_token_share: round(synthesisShare),
    mean_retrieval_ms: round(meanOf(r => r.timing?.retrieval_ms), 0),
    mean_synthesis_ms: round(meanOf(r => r.timing?.synthesis_ms), 0),
    retrieval_time_share: round(retrievalTimeShare),
    mean_passes: round(meanPasses, 1),
    mean_graph_hops: round(meanOf(r => r.retrieval?.graph_hops), 1),
    exhaustion_rate: round(exhaustionRate),
    mean_facts_to_synthesis: round(meanFactsToSynthesis, 0),
    curator_fallback_questions: curatorFallbacks.map(r => r.question_index),
    total_curator_kept: totalKept,
    total_curator_dropped: totalDropped,
    curator_drop_rate: curatorDenom > 0 ? round(totalDropped / curatorDenom) : null,
    slowest_question: byDuration[0]
      ? { question_index: byDuration[0].question_index, total_duration_ms: byDuration[0].total_duration_ms }
      : null,
    heaviest_thinking_question: byThinking[0]
      ? { question_index: byThinking[0].question_index, thinking_tokens: byThinking[0].tokens?.thinking ?? 0 }
      : null,
    diagnosis,
  }
}

/**
 * Print a compact per-run timeline diagnosis to stdout: the token/time split, curator drop
 * rate, the slowest question, and the plain-language flags. Called at the end of a harvest so
 * the operator (or a cloud task session reading the log) sees *where the budget went* without
 * opening the artifact JSON.
 */
export function printTimelineDiagnosis(summary, timeline) {
  if (!summary) return
  const pct = v => (v == null ? '  -' : `${(v * 100).toFixed(0)}%`)
  console.log('')
  console.log(` TIMELINE (K · ${summary.questions} questions) — where the query budget went`)
  console.log(
    `  tokens   thinking ${formatCompactTokens(summary.mean_thinking_tokens)} (${pct(summary.thinking_token_share)})   synthesis ${formatCompactTokens(summary.mean_synthesis_tokens)} (${pct(summary.synthesis_token_share)})   [mean/question]`
  )
  console.log(
    `  time     retrieval ${formatDurationMs(summary.mean_retrieval_ms)} (${pct(summary.retrieval_time_share)})   synthesis ${formatDurationMs(summary.mean_synthesis_ms)}   total ${formatDurationMs(summary.mean_total_duration_ms)}`
  )
  console.log(
    `  loop     passes ${summary.mean_passes ?? '-'}   graph_hops ${summary.mean_graph_hops ?? '-'}   exhausted ${pct(summary.exhaustion_rate)}   facts→synth ${summary.mean_facts_to_synthesis ?? '-'}`
  )
  console.log(
    `  curator  dropped ${summary.total_curator_dropped}/${summary.total_curator_kept + summary.total_curator_dropped} (${pct(summary.curator_drop_rate)})${summary.curator_fallback_questions?.length ? `   fell back on Q${summary.curator_fallback_questions.join(', Q')}` : ''}`
  )
  if (summary.slowest_question) {
    console.log(
      `  slowest  Q${summary.slowest_question.question_index} at ${formatDurationMs(summary.slowest_question.total_duration_ms)}`
    )
  }
  for (const line of summary.diagnosis ?? []) {
    console.log(`  ▶ ${line}`)
  }
  void timeline
}

export function scoreMetric(artifact, key) {
  const q = artifact?.aggregate_scores?.query
  const c = artifact?.aggregate_scores?.combined
  if (key === 'success_score') return q?.success_score ?? c?.success_score ?? null
  if (key === 'usefulness') return q?.mean_usefulness ?? c?.mean_usefulness ?? null
  if (key === 'pass_rate')
    return (
      // Prefer the relevance-inclusive gate; fall back to the legacy field for old artifacts.
      q?.pass_rate_quality_axes_at_least_3 ??
      c?.pass_rate_quality_axes_at_least_3 ??
      q?.pass_rate_correctness_and_usefulness_at_least_3 ??
      c?.pass_rate_correctness_and_usefulness_at_least_3 ??
      null
    )
  if (key === 'correctness') return q?.mean_correctness ?? c?.mean_correctness ?? null
  if (key === 'relevance') return q?.mean_relevance ?? c?.mean_relevance ?? null
  return null
}

export function structuralMetric(artifact, key) {
  const init = artifact?.run?.init_result
  const gs = init?.graph_summary
  if (key === 'docs') return init?.written_docs ?? null
  if (key === 'entities') return gs?.entities ?? null
  if (key === 'rels') return gs?.relationships ?? null
  if (key === 'avg_results') {
    const qe = artifact?.query_evaluation ?? []
    if (!qe.length) return null
    const counts = qe.map(q => q.result_count ?? 0)
    return counts.reduce((a, b) => a + b, 0) / counts.length
  }
  return null
}

export function matchesSuite(row, suite) {
  if (!suite) return true
  const p = suite.toLowerCase()
  const a = row.artifact
  const runSuite = (a?.run?.suite ?? '').toLowerCase()
  if (runSuite) return runSuite === p
  const haystack = [row.id, a?.repository?.name, a?.run_label, a?.run?.run_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(p)
}

/**
 * Which experiment condition produced an artifact: 'control' (real agent, no KB),
 * 'kb' (KB-equipped), or null if not tagged. Used to keep control and KB runs
 * for the same suite separable in trend tables and comparisons.
 */
export function conditionOf(artifact) {
  const c = artifact?.run?.condition
  if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase()
  // Back-compat: untagged harvest artifacts are KB runs.
  if (artifact?.run?.mode === 'control_agent') return 'control'
  return null
}

/** Paper condition shorthand: K = kb query side, N = control agent (no KB). */
export function conditionSideLabel(cond) {
  if (cond === 'control') return 'N'
  return 'K'
}

/** Human-readable condition label for eval summaries (suite ≠ condition). */
export function conditionSideLongLabel(cond) {
  if (cond === 'control') return 'N (control agent)'
  return 'K (kb query)'
}

/** Suite display name from eval/suites/<id>.yaml (falls back to id). */
export function suiteDisplayLabel(suiteId) {
  try {
    return loadVendorSuite(suiteId).displayName ?? suiteId
  } catch {
    return suiteId
  }
}

/** Suites exported to research/tables/results.tex for the paper. */
export const RESEARCH_RESULT_SUITES = [
  'kb',
  'raylib',
  'fzf',
  'kestra',
  'shellcheck',
  'lazygit',
  'datasette',
  'mitmproxy',
  'fish-shell',
  'brew',
]

// ---------------------------------------------------------------------------
// Run directory allocation + clone (shared by eval-run.mjs and control-core.mjs)
// ---------------------------------------------------------------------------

/**
 * Run folder basename: `<repoLeaf>-YYYY-MM-DD-HHmm`, suffixed `-2`, `-3`, … if the
 * name is already taken (same-minute rerun).
 */
export function allocateRunName(repoLeaf) {
  const leaf = sanitizeSlugPart(repoLeaf)
  const dateStr = dayjs().format('YYYY-MM-DD')
  const timeStr = dayjs().format('HHmm')
  const stem = `${leaf}-${dateStr}-${timeStr}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const root = evaluationsRoot()
  let name = stem
  let n = 0
  while (fs.existsSync(path.join(root, name))) {
    n += 1
    name = `${stem}-${n}`
  }
  return name
}

/** Fresh snapshot clone: removes dest if present. */
export function gitCloneSnapshot({ url, dest, branch, depth }) {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const args = ['clone']
  if (depth > 0) args.push(`--depth=${String(depth)}`)
  if (branch) args.push('-b', branch)
  args.push(url, dest)
  console.error(`[eval] git ${args.join(' ')}`)
  const r = spawnSync('git', args, { stdio: 'inherit', encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git clone failed with status ${r.status}`)
}

// ---------------------------------------------------------------------------
// Trends summary (shared by eval-run.mjs and control-core.mjs)
// ---------------------------------------------------------------------------

/** Format kb − control delta for summary tables. */
export function formatScoreDelta(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '   -   '
  return ((n >= 0 ? '+' : '') + n.toFixed(3)).padStart(7)
}

/** One-line verdict from kb vs control score objects. */
export function kbControlVerdict(kbScores, ctrlScores) {
  // Primary: composite success score when both sides have it.
  const ks = kbScores?.success
  const cs = ctrlScores?.success
  if (typeof ks === 'number' && typeof cs === 'number') {
    const d = ks - cs
    if (d >= 0.02) return 'ahead of control'
    if (d <= -0.02) return 'behind control'
    return 'on par with control'
  }
  // Fallback (old artifacts without success_score): sweep the quality axes.
  const axes = ['pass', 'correctness', 'usefulness']
  const deltas = axes
    .map(k => {
      const a = kbScores?.[k]
      const b = ctrlScores?.[k]
      return typeof a === 'number' && typeof b === 'number' ? a - b : null
    })
    .filter(d => d !== null)
  if (!deltas.length) return 'no comparison'
  const ahead = deltas.filter(d => d >= 0).length
  if (ahead === deltas.length) return 'ahead or tied vs control'
  if (ahead === 0) return 'behind control'
  return 'mixed vs control'
}

/** Largest correctness gaps (kb − control), most negative first. */
export function worstQuestionGaps(kbEvals, ctrlEvals, questions, limit = 3) {
  const gaps = (kbEvals ?? [])
    .map((kb, i) => {
      const ctrl = ctrlEvals?.[i]
      const kbCorr = kb?.scores?.correctness
      const ctrlCorr = ctrl?.scores?.correctness
      if (typeof kbCorr !== 'number' || typeof ctrlCorr !== 'number') return null
      return {
        q: i + 1,
        topic: String(questions?.[i] ?? '').slice(0, 42),
        kb: kbCorr,
        ctrl: ctrlCorr,
        gap: kbCorr - ctrlCorr,
      }
    })
    .filter(Boolean)
  gaps.sort((a, b) => a.gap - b.gap)
  return gaps.slice(0, limit)
}

function _safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function _fmtN(n) {
  if (n === null || n === undefined) return '  -'
  if (Number.isInteger(n)) return String(n).padStart(3)
  return n.toFixed(1).padStart(5)
}

function _fmtScore(n) {
  return n === null || n === undefined ? '  -  ' : n.toFixed(3)
}

function _padScore(n) {
  return n === null || n === undefined ? '  -   ' : n.toFixed(3).padStart(6)
}

function _queryScores(artifact) {
  const q = artifact?.aggregate_scores?.query ?? artifact?.aggregate_scores?.combined ?? {}
  return {
    success: q.success_score ?? null,
    quality: q.quality_score ?? null,
    tokens: q.token_efficiency ?? null,
    speed: q.speed_score ?? null,
    pass:
      q.pass_rate_quality_axes_at_least_3 ??
      q.pass_rate_correctness_and_usefulness_at_least_3 ??
      null,
    correctness: q.mean_correctness ?? null,
    usefulness: q.mean_usefulness ?? null,
    relevance: q.mean_relevance ?? null,
    specificity: q.mean_specificity ?? null,
    evidence: q.mean_evidence_handling ?? null,
  }
}

/** Compact token count for summary tables (e.g. 389900 → "390k"). */
export function formatCompactTokens(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '  -'
  const v = Math.round(Number(n))
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

/** Wall-clock duration for summary tables (e.g. 161935 → "162s"). */
export function formatDurationMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '  -'
  const s = Math.round(Number(ms) / 1000)
  if (s >= 600) return `${(s / 60).toFixed(1)}m`
  return `${s}s`
}

function _runTelemetry(artifact, side) {
  if (side === 'kb') {
    const tel = artifact?.kb_query_telemetry
    const inputs = artifact?.success_score_inputs
    return {
      weightedTokens: tel
        ? (tel.total_input_tokens ?? 0) + (tel.total_output_tokens ?? 0)
        : (inputs?.total_tokens ?? null),
      durationMs: tel?.total_duration_ms ?? inputs?.total_duration_ms ?? null,
      cacheReadTokens: null,
      costUsd: tel?.total_cost_usd ?? null,
      meanTurns: tel?.mean_num_turns ?? null,
    }
  }
  const tel =
    artifact?.control?.control_telemetry ?? artifact?.comparison?.control_efficiency ?? null
  return {
    weightedTokens: tel?.total_weighted_tokens ?? null,
    durationMs: tel?.total_duration_ms ?? null,
    cacheReadTokens: tel?.total_cache_read_tokens ?? null,
    costUsd: tel?.total_cost_usd ?? null,
    meanTurns: tel?.mean_num_turns ?? null,
  }
}

function _summaryLine(ch = '─', width = 62) {
  return ch.repeat(width)
}

function _trendNote(values) {
  const nums = values.filter(v => typeof v === 'number')
  if (nums.length < 2) return ''
  const prev = nums[nums.length - 2]
  const last = nums[nums.length - 1]
  const d = last - prev
  const sign = d >= 0 ? '+' : ''
  return `${prev.toFixed(3)} → ${last.toFixed(3)} (${sign}${d.toFixed(3)} vs prev)`
}

function _gatherArtifacts(_repoRoot) {
  const rows = []
  const homeRoot = path.join(os.homedir(), '.kb', 'evaluations')
  if (fs.existsSync(homeRoot)) {
    for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'repos' || entry.name.startsWith('_')) continue
      const artifactPath = path.join(homeRoot, entry.name, 'artifact.json')
      if (!fs.existsSync(artifactPath)) continue
      const artifact = _safeJson(artifactPath)
      if (!artifact?.status) continue
      rows.push({ source: 'home', id: entry.name, file: artifactPath, artifact })
    }
  }
  return rows
}

/** Most recent scored harvest artifact for a suite (K-side artifact.json). */
export function findLatestSuiteArtifact(suiteId, repoRoot) {
  return (
    _gatherArtifacts(repoRoot)
      .filter(row => matchesSuite(row, suiteId))
      .filter(row => conditionOf(row.artifact) !== 'control')
      .filter(row => row.artifact?.aggregate_scores?.query?.success_score != null)
      .sort((a, b) => {
        const ta = new Date(a.artifact?.created_at ?? 0).getTime()
        const tb = new Date(b.artifact?.created_at ?? 0).getTime()
        return tb - ta
      })[0]?.artifact ?? null
  )
}

function _texEscape(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/_/g, '\\_')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
}

function _texMacro(name, value) {
  return `\\newcommand{\\${name}}{${value}}`
}

function _texNum(n, decimals = 3) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '---'
  return Number(n).toFixed(decimals)
}

function _texSigned(n, decimals = 3) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '---'
  const v = Number(n)
  const s = v.toFixed(decimals)
  return v >= 0 ? `+${s}` : s
}

function _texInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '---'
  return Math.round(Number(n))
    .toLocaleString('en-US')
    .replace(/,/g, '{,}')
}

function _texDurationSec(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '---'
  return String(Math.round(Number(ms) / 1000))
}

function _sideHarvestMetrics(artifact, side) {
  const data = side === 'K' ? artifact : artifact?.control
  if (!data?.aggregate_scores?.query) return null
  const scores = _queryScores(data)
  const tel = _runTelemetry(artifact, side === 'K' ? 'kb' : 'control')
  const init = side === 'K' ? artifact?.run?.init_result : null
  return {
    success: scores.success,
    quality: scores.quality,
    tokenEfficiency: scores.tokens,
    speed: scores.speed,
    pass: scores.pass,
    correctness: scores.correctness,
    usefulness: scores.usefulness,
    relevance: scores.relevance,
    specificity: scores.specificity,
    evidence: scores.evidence,
    weightedTokens: tel.weightedTokens,
    durationMs: tel.durationMs,
    cacheReadTokens: tel.cacheReadTokens,
    costUsd: tel.costUsd,
    docs: init?.written_docs ?? null,
    entities: init?.graph_summary?.entities ?? null,
    relationships: init?.graph_summary?.relationships ?? null,
  }
}

/** True when artifact control is fully answered and may overwrite N-side macros. */
function _controlCompleteForOverwrite(artifact) {
  return artifact?.control?.status === 'complete'
}

function _judgeLabel(artifact) {
  const qs = artifact?.query_scoring
  if (qs?.mode === 'llm_judge_avg_3') {
    return 'LLM-as-judge, averaged over three scorer calls'
  }
  return 'LLM-as-judge'
}

function _controlAgentLabel(artifact) {
  const agent = artifact?.control?.agent
  if (agent?.name && agent?.model) return `Headless agent: ${agent.name} (${agent.model})`
  if (agent?.name) return `Headless agent: ${agent.name}`
  return 'Headless coding agent'
}

function _formatRunDate(iso) {
  if (!iso) return 'unknown date'
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function _suiteTexPrefix(suiteId) {
  if (suiteId === 'kb') return 'KbSelfCheck'
  if (suiteId === 'raylib') return 'Raylib'
  return suiteId
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

function _suiteNameLabel(suiteId) {
  if (suiteId === 'kb') return '\\texttt{kb} self-check'
  return `\\texttt{${_texEscape(suiteDisplayLabel(suiteId))}}`
}

function _suiteCommitLabel(artifact) {
  const commit = artifact?.repository?.commit
  const short = commit ? commit.slice(0, 7) : 'unknown'
  return `\\texttt{${_texEscape(short)}}`
}

/** @deprecated Combined label; prefer Suite + Commit macros for the paper table. */
function _suiteTargetLabel(suiteId, artifact) {
  return `${_suiteNameLabel(suiteId)} commit ${_suiteCommitLabel(artifact)}`
}

/** Parse `\\newcommand{\\Name}{value}` macros (brace-balanced values). */
export function parseResultsTexMacros(content) {
  const map = new Map()
  if (!content) return map
  const re = /\\newcommand\{\\([A-Za-z0-9]+)\}\{/g
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const name = m[1]
    let i = re.lastIndex
    let depth = 1
    const start = i
    while (i < content.length && depth > 0) {
      const c = content[i++]
      if (c === '{') depth++
      else if (c === '}') depth--
    }
    map.set(name, content.slice(start, i - 1))
  }
  return map
}

function _readPriorResultsMacros(outPath) {
  if (!fs.existsSync(outPath)) return new Map()
  try {
    return parseResultsTexMacros(fs.readFileSync(outPath, 'utf-8'))
  } catch {
    return new Map()
  }
}

function _parseTexNum(s) {
  if (s == null || s === '' || s === '---') return null
  const n = Number(String(s).replace(/^\+/, ''))
  return Number.isFinite(n) ? n : null
}

/** Prefer newValue; otherwise keep prior macro text; otherwise `---`. */
function _pushMacro(lines, prior, name, newValue) {
  if (newValue != null) {
    lines.push(_texMacro(name, newValue))
    return
  }
  if (prior?.has(name)) {
    lines.push(_texMacro(name, prior.get(name)))
    return
  }
  lines.push(_texMacro(name, '---'))
}

function _pushSideMacros(lines, prior, prefix, side, metrics) {
  const defs = [
    ['S', metrics ? _texNum(metrics.success) : null],
    ['Qadeq', metrics ? _texNum(metrics.quality) : null],
    ['Etok', metrics ? _texNum(metrics.tokenEfficiency) : null],
    ['Espeed', metrics ? _texNum(metrics.speed) : null],
    ['Pass', metrics ? _texNum(metrics.pass) : null],
    ['Correctness', metrics ? _texNum(metrics.correctness, 3) : null],
    ['Usefulness', metrics ? _texNum(metrics.usefulness, 3) : null],
    ['Relevance', metrics ? _texNum(metrics.relevance, 3) : null],
    ['Tokens', metrics ? _texInt(metrics.weightedTokens) : null],
    ['DurationSec', metrics ? _texDurationSec(metrics.durationMs) : null],
    ['Docs', metrics ? _texInt(metrics.docs) : null],
    ['Entities', metrics ? _texInt(metrics.entities) : null],
    ['Rels', metrics ? _texInt(metrics.relationships) : null],
  ]
  for (const [suffix, value] of defs) {
    // Only overwrite when this side was actually measured; never blank prior.
    _pushMacro(lines, prior, `${prefix}${side}${suffix}`, metrics ? value : null)
  }
}

function _emitSuiteResults(lines, suiteId, artifact, prior) {
  const prefix = _suiteTexPrefix(suiteId)
  const k = artifact ? _sideHarvestMetrics(artifact, 'K') : null
  const overwriteN = Boolean(artifact && _controlCompleteForOverwrite(artifact))
  const n = overwriteN ? _sideHarvestMetrics(artifact, 'N') : null

  const kSuccess = k?.success ?? _parseTexNum(prior?.get(`${prefix}KS`))
  const nSuccess = n?.success ?? _parseTexNum(prior?.get(`${prefix}NS`))
  const deltaS =
    kSuccess != null && nSuccess != null ? kSuccess - nSuccess : null
  const controlCollected =
    overwriteN || nSuccess != null || prior?.get(`${prefix}ControlCollected`) === 'yes'
      ? 'yes'
      : prior?.has(`${prefix}ControlCollected`)
        ? null // preserve whatever prior said (usually "no")
        : 'no'

  lines.push(`%% ── suite ${suiteId} ──`)

  if (k) {
    _pushMacro(
      lines,
      prior,
      `${prefix}RunId`,
      _texEscape(artifact.run?.run_name ?? artifact.run_label ?? '---')
    )
    _pushMacro(lines, prior, `${prefix}RunDate`, _formatRunDate(artifact.created_at))
    _pushMacro(lines, prior, `${prefix}Suite`, _suiteNameLabel(suiteId))
    _pushMacro(lines, prior, `${prefix}Commit`, _suiteCommitLabel(artifact))
  } else {
    _pushMacro(lines, prior, `${prefix}RunId`, null)
    _pushMacro(lines, prior, `${prefix}RunDate`, null)
    _pushMacro(lines, prior, `${prefix}Suite`, null)
    _pushMacro(lines, prior, `${prefix}Commit`, null)
  }

  _pushMacro(
    lines,
    prior,
    `${prefix}ControlCollected`,
    overwriteN ? 'yes' : controlCollected
  )
  _pushMacro(
    lines,
    prior,
    `${prefix}ControlAgent`,
    overwriteN ? _texEscape(_controlAgentLabel(artifact)) : null
  )
  _pushMacro(lines, prior, `${prefix}DeltaS`, deltaS != null ? _texSigned(deltaS) : null)

  _pushSideMacros(lines, prior, prefix, 'K', k)
  _pushSideMacros(lines, prior, prefix, 'N', n)
  lines.push('')
}

/**
 * Regenerate research/tables/results.tex from the latest scored harvest evaluations.
 *
 * Merges with the existing file: K-side macros update from the latest scored kb
 * artifact; N-side macros update only when that artifact has a *complete* control
 * run. `--skip-control`, partial control, or missing suites never blank prior N.
 */
export function writeResearchResultsTex(repoRoot, options = {}) {
  const suites = options.suites ?? RESEARCH_RESULT_SUITES
  const outPath =
    options.outPath ?? path.join(repoRoot, 'research', 'tables', 'results.tex')
  const prior = _readPriorResultsMacros(outPath)

  const suiteArtifacts = Object.fromEntries(
    suites.map(id => [id, findLatestSuiteArtifact(id, repoRoot)])
  )
  const dated = suites
    .map(id => suiteArtifacts[id]?.created_at)
    .filter(Boolean)
    .sort()
    .reverse()[0]

  const judgeArtifact =
    suiteArtifacts.kb?.query_scoring?.provider != null
      ? suiteArtifacts.kb
      : suiteArtifacts.raylib

  // Control status reflects the *merged* paper table (prior N counts), not only
  // whether the newest artifact happened to re-run control.
  const suitesWithN = suites.filter(id => {
    const a = suiteArtifacts[id]
    if (a && _controlCompleteForOverwrite(a)) return true
    const prefix = _suiteTexPrefix(id)
    return _parseTexNum(prior.get(`${prefix}NS`)) != null
  })
  const suiteListTex = suites.map(id => `\\texttt{${id}}`).join(', ')
  let controlStatus
  if (suitesWithN.length === suites.length) {
    controlStatus = `paired K-vs-N evaluations on ${suiteListTex} (\\ResultsUpdated)`
  } else if (suitesWithN.length > 0) {
    const missing = suites
      .filter(id => !suitesWithN.includes(id))
      .map(id => `\\texttt{${id}}`)
      .join(', ')
    controlStatus = `control side pending for ${missing}; K-side results reported (\\ResultsUpdated); see Table~\\ref{tab:harvest-results}`
  } else {
    controlStatus =
      'no paired control evaluations in the latest scored runs; K-side only; see Table~\\ref{tab:harvest-results}'
  }

  // Prefer prior ResultsJudge when no new scored artifact carries judge metadata.
  const judgeLabel = judgeArtifact
    ? _judgeLabel(judgeArtifact)
    : prior.get('ResultsJudge')?.replace(/\\_/g, '_') || 'LLM-as-judge'

  const lines = [
    '% Auto-generated harvest result macros — do not edit by hand.',
    '',
    _texMacro(
      'ResultsUpdated',
      dated ? _formatRunDate(dated) : (prior.get('ResultsUpdated') ?? _formatRunDate(new Date().toISOString()))
    ),
    _texMacro('ResultsJudge', _texEscape(judgeLabel)),
    _texMacro('ResultsControlStatus', controlStatus),
    '',
  ]

  for (const suiteId of suites) {
    _emitSuiteResults(lines, suiteId, suiteArtifacts[suiteId], prior)
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf-8')
  return { outPath, suites: suiteArtifacts }
}

/**
 * Print a structured eval summary: this-run scorecard, kb trend, recent history.
 * `options.currentRunId` highlights the run that just finished (basename of run dir).
 */
export function printTrendsSummary(suiteId, repoRoot, options = {}) {
  const { currentRunId = null } = options
  const all = _gatherArtifacts(repoRoot)
  const buildRow = (row, cond, data) => ({
    ...row,
    cond,
    created: row.artifact?.created_at ?? null,
    success_score: scoreMetric(data, 'success_score'),
    quality_score: data?.aggregate_scores?.query?.quality_score ?? null,
    token_efficiency: data?.aggregate_scores?.query?.token_efficiency ?? null,
    speed_score: data?.aggregate_scores?.query?.speed_score ?? null,
    usefulness: scoreMetric(data, 'usefulness'),
    pass_rate: scoreMetric(data, 'pass_rate'),
    correctness: scoreMetric(data, 'correctness'),
    scores: _queryScores(data),
    artifactData: data,
  })
  const filtered = all
    .filter(row => matchesSuite(row, suiteId))
    .flatMap(row => {
      const out = [buildRow(row, conditionOf(row.artifact) ?? 'kb', row.artifact)]
      const control = row.artifact?.control
      if (control?.aggregate_scores) {
        out.push(buildRow({ ...row, id: `${row.id} [control]` }, 'control', control))
      }
      return out
    })
    .sort((a, b) => {
      const ta = a.created ? new Date(a.created).getTime() : Number.NaN
      const tb = b.created ? new Date(b.created).getTime() : Number.NaN
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })

  if (filtered.length === 0) {
    console.log(`\n[eval] no prior runs for suite "${suiteId}"`)
    return
  }

  const kbs = filtered.filter(r => r.cond !== 'control')
  const controls = filtered.filter(r => r.cond === 'control')
  const currentKb =
    (currentRunId && kbs.find(r => r.id === currentRunId)) || kbs[kbs.length - 1]
  const currentArtifact = currentKb?.artifact
  const sameRunControl =
    currentArtifact?.control?.status === 'complete' ||
    currentArtifact?.control?.status === 'complete_unscored'
      ? currentArtifact.control
      : null
  const ctrlForCompare = sameRunControl
    ? _queryScores(sameRunControl)
    : controls[controls.length - 1]?.scores
  const kbScores = currentKb?.scores ?? _queryScores(currentArtifact)

  const runLabel = currentKb?.id ?? currentRunId ?? 'latest'
  const suiteLabel = suiteDisplayLabel(suiteId)
  console.log('')
  console.log(_summaryLine('═'))
  console.log(` eval summary · suite=${suiteId} (${suiteLabel}) · ${runLabel}`)
  console.log(_summaryLine('═'))

  if (ctrlForCompare && kbScores) {
    const delta = k => {
      const a = kbScores[k]
      const b = ctrlForCompare[k]
      return typeof a === 'number' && typeof b === 'number' ? a - b : null
    }
    const deltaS = delta('success')
    console.log('')
    console.log(` THIS RUN — ${conditionSideLongLabel('kb')} vs ${conditionSideLongLabel('control')} · ${suiteLabel}`)
    console.log(
      ` ΔS = ${formatScoreDelta(deltaS).trim()}  (${kbControlVerdict(kbScores, ctrlForCompare)}, threshold ±0.02)`
    )
    console.log(' S = 0.60·Q_adeq + 0.30·E_tok + 0.10·E_speed')
    console.log('            S      Q_adeq  E_tok  E_speed')
    console.log(
      ` N (ctrl)  ${_padScore(ctrlForCompare.success)}  ${_padScore(ctrlForCompare.quality)}  ${_padScore(ctrlForCompare.tokens)}  ${_padScore(ctrlForCompare.speed)}`
    )
    console.log(
      ` K (query) ${_padScore(kbScores.success)}  ${_padScore(kbScores.quality)}  ${_padScore(kbScores.tokens)}  ${_padScore(kbScores.speed)}`
    )
    console.log(
      ` Δ K−N     ${formatScoreDelta(delta('success'))}  ${formatScoreDelta(delta('quality'))}  ${formatScoreDelta(delta('tokens'))}  ${formatScoreDelta(delta('speed'))}`
    )

    const kbTel = _runTelemetry(currentArtifact, 'kb')
    const ctrlTel = _runTelemetry(currentArtifact, 'control')
    if (kbTel.weightedTokens != null || ctrlTel.weightedTokens != null) {
      console.log('')
      const questionCount = currentArtifact?.query_evaluation?.length
      console.log(
        ` TELEMETRY (${questionCount != null ? `${questionCount} questions` : 'questions'})`
      )
      console.log('            tokens   time')
      console.log(
        ` K (query) ${formatCompactTokens(kbTel.weightedTokens).padStart(6)}  ${formatDurationMs(kbTel.durationMs).padStart(5)}`
      )
      console.log(
        ` N (ctrl)  ${formatCompactTokens(ctrlTel.weightedTokens).padStart(6)}  ${formatDurationMs(ctrlTel.durationMs).padStart(5)}`
      )
      if (ctrlTel.cacheReadTokens) {
        console.log(
          `            N weighted: input+output+0.1×cache (${formatCompactTokens(ctrlTel.cacheReadTokens)} cache read)`
        )
      }
      if (kbTel.costUsd != null || ctrlTel.costUsd != null) {
        const kbCost =
          kbTel.costUsd != null ? `$${Number(kbTel.costUsd).toFixed(2)}` : '  -'
        const ctrlCost =
          ctrlTel.costUsd != null ? `$${Number(ctrlTel.costUsd).toFixed(2)}` : '  -'
        console.log(`            cost  K ${kbCost}  N ${ctrlCost}`)
      }
    }

    console.log('')
    console.log(' RUBRIC (secondary)')
    console.log('            pass    corr     use     rel')
    console.log(
      ` N (ctrl)  ${_padScore(ctrlForCompare.pass)}  ${_padScore(ctrlForCompare.correctness)}  ${_padScore(ctrlForCompare.usefulness)}  ${_padScore(ctrlForCompare.relevance)}`
    )
    console.log(
      ` K (query) ${_padScore(kbScores.pass)}  ${_padScore(kbScores.correctness)}  ${_padScore(kbScores.usefulness)}  ${_padScore(kbScores.relevance)}`
    )
    console.log(
      ` Δ K−N     ${formatScoreDelta(delta('pass'))}  ${formatScoreDelta(delta('correctness'))}  ${formatScoreDelta(delta('usefulness'))}  ${formatScoreDelta(delta('relevance'))}`
    )
    {
      const kbCur = currentArtifact?.aggregate_scores?.query?.curation_summary
      if (kbCur?.retrieval_precision != null) {
        console.log('')
        console.log(
          ` CURATOR (K): retrieval precision ${kbCur.retrieval_precision} (kept ${kbCur.total_kept}, dropped ${kbCur.total_dropped} across ${kbCur.questions_with_curation} q)`
        )
      }
    }
    if (sameRunControl && currentArtifact?.query_evaluation?.length) {
      const worst = worstQuestionGaps(
        currentArtifact.query_evaluation,
        sameRunControl.query_evaluation,
        currentArtifact.question_set,
        3
      ).filter(g => g.gap < 0)
      if (worst.length) {
        console.log('')
        console.log(' WEAKEST (corr gap, K − N)')
        for (const g of worst) {
          console.log(
            `   Q${g.q}  ${g.topic.padEnd(42)}  K=${g.kb.toFixed(1)}  N=${g.ctrl.toFixed(1)}  Δ=${formatScoreDelta(g.gap).trim()}`
          )
        }
      }
    }

  } else if (kbScores) {
    console.log('')
    console.log(` THIS RUN — K (kb query) only · ${suiteLabel} (no control in artifact)`)
    console.log(
      ` S=${_padScore(kbScores.success).trim()}  Q_adeq=${_padScore(kbScores.quality).trim()}  E_tok=${_padScore(kbScores.tokens).trim()}  E_speed=${_padScore(kbScores.speed).trim()}`
    )
    const kbTel = _runTelemetry(currentArtifact, 'kb')
    if (kbTel.weightedTokens != null || kbTel.durationMs != null) {
      console.log(
        ` tokens=${formatCompactTokens(kbTel.weightedTokens)}  time=${formatDurationMs(kbTel.durationMs)}`
      )
    }
    console.log(
      ` pass=${_padScore(kbScores.pass).trim()}  corr=${_padScore(kbScores.correctness).trim()}  use=${_padScore(kbScores.usefulness).trim()}`
    )
  }

  const kbHistory = kbs.slice(-12)
  if (kbHistory.length >= 2) {
    const successSeries = kbHistory.map(r => r.success_score)
    const tokSeries = kbHistory.map(r => r.token_efficiency)
    const speedSeries = kbHistory.map(r => r.speed_score)
    console.log('')
    console.log(` K TREND · suite ${suiteLabel} (last runs)`)
    console.log(` S        ${sparkline(successSeries)}  ${_trendNote(successSeries)}`)
    console.log(` E_tok    ${sparkline(tokSeries)}  ${_trendNote(tokSeries)}`)
    console.log(` E_speed  ${sparkline(speedSeries)}  ${_trendNote(speedSeries)}`)
  }

  const recent = filtered.slice(-14)
  const W = 22
  console.log('')
  console.log(' RECENT RUNS')
  console.log(
    `${'date'.padEnd(17)} ${'side'.padEnd(7)} ${'S'.padStart(6)} ${'Q'.padStart(6)} ${'tok'.padStart(6)} ${'spd'.padStart(6)}  run`
  )
  console.log(_summaryLine())
  for (const r of recent) {
    const dt = r.created ? String(r.created).slice(0, 16).replace('T', ' ') : 'unknown'
    const marker = r.id === runLabel || r.id === `${runLabel} [control]` ? ' ←' : ''
    const id =
      r.id.length > W ? `${r.id.slice(0, W - 1)}…` : r.id
    console.log(
      `${dt.padEnd(17)} ${conditionSideLabel(r.cond).padEnd(7)} ${_padScore(r.success_score).padStart(6)} ${_padScore(r.quality_score)} ${_padScore(r.token_efficiency)} ${_padScore(r.speed_score)}  ${id}${marker}`
    )
  }
  console.log(_summaryLine('═'))
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export function sparkline(values, maxWidth = 28) {
  const chars = '▁▂▃▄▅▆▇█'
  const nums = values.filter(v => typeof v === 'number')
  if (!nums.length) return ''
  const trimmed = nums.slice(Math.max(0, nums.length - maxWidth))
  const min = Math.min(...trimmed)
  const max = Math.max(...trimmed)
  if (max === min) return '▅'.repeat(trimmed.length)
  return trimmed
    .map(v => {
      const idx = Math.max(0, Math.min(7, Math.round(((v - min) / (max - min)) * 7)))
      return chars[idx]
    })
    .join('')
}
