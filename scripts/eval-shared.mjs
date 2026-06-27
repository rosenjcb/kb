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
 * Normalize a raw YAML suite object for eval-run.mjs (strict 8-question validation).
 * @returns {{ id, questions, answers, rubricPhrase, sourceFile, repoUrl }}
 */
export function normalizeSuiteDoc(raw, sourceFile) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid suite YAML (not an object): ${sourceFile}`)
  }
  const qs = raw.questions
  if (!Array.isArray(qs) || qs.length !== 8 || !qs.every(q => typeof q === 'string' && q.trim())) {
    throw new Error(`${sourceFile}: require questions: as exactly 8 non-empty strings`)
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
  const resultCount = Number(/^matches>\s*(\d+)\s+ranked/m.exec(text)?.[1] ?? 0)
  const sourcesRaw = /^sources>\s*top \d+ of \d+ ranked:\s*(.+)$/m.exec(text)?.[1] ?? ''
  const provenance = sourcesRaw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
  return {
    answer,
    result_count: resultCount,
    provenance,
    retrieval: { method, detail: retrievalLine, confidence: null },
  }
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
export const RESEARCH_RESULT_SUITES = ['kb', 'raylib']

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

function _gatherArtifacts(repoRoot) {
  const rows = []
  const homeRoot = path.join(os.homedir(), '.kb', 'evaluations')
  const repoRuns = path.join(repoRoot, 'evaluation', 'runs')
  if (fs.existsSync(homeRoot)) {
    for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'repos') continue
      const artifactPath = path.join(homeRoot, entry.name, 'artifact.json')
      if (!fs.existsSync(artifactPath)) continue
      const artifact = _safeJson(artifactPath)
      if (!artifact?.status) continue
      rows.push({ source: 'home', id: entry.name, file: artifactPath, artifact })
    }
  }
  if (fs.existsSync(repoRuns)) {
    for (const entry of fs.readdirSync(repoRuns, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const artifactPath = path.join(repoRuns, entry.name)
      const artifact = _safeJson(artifactPath)
      if (!artifact?.status) continue
      rows.push({
        source: 'repo',
        id: entry.name.replace(/\.json$/i, ''),
        file: artifactPath,
        artifact,
      })
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

function _controlCollected(artifact) {
  const st = artifact?.control?.status
  return st === 'complete' || st === 'complete_unscored'
}

function _judgeLabel(artifact) {
  const qs = artifact?.query_scoring
  if (!qs?.provider || !qs?.model) return 'LLM judge (provider unknown)'
  const mode = qs.mode === 'llm_judge_avg_3' ? ', averaged over three scorer calls' : ''
  const model = String(qs.model).replace(/^gemini-/i, 'Gemini ').replace(/^gpt-/i, 'GPT-')
  const prov =
    qs.provider.toLowerCase() === 'gemini'
      ? ''
      : `${qs.provider.charAt(0).toUpperCase()}${qs.provider.slice(1)} `
  return `${prov}${model}${mode}`.trim()
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

function _suiteTargetLabel(suiteId, artifact) {
  if (suiteId === 'kb') return '\\texttt{kb} self-check'
  if (suiteId === 'raylib') {
    const commit = artifact?.repository?.commit
    const short = commit ? commit.slice(0, 7) : 'unknown'
    return `\\texttt{raylib} commit \\texttt{${_texEscape(short)}}`
  }
  const name = artifact?.repository?.name ?? suiteDisplayLabel(suiteId)
  return `\\texttt{${_texEscape(name)}}`
}

function _controlAgentLabel(artifact) {
  const agent = artifact?.control?.agent
  if (!agent?.name) return 'unknown agent'
  const model = agent.model ? ` ${agent.model}` : ''
  const name = agent.name.replace(/-agent$/i, '').replace(/-/g, ' ')
  return `${name.charAt(0).toUpperCase() + name.slice(1)}${model}`
}

function _emitSuiteResults(lines, suiteId, artifact) {
  const prefix = _suiteTexPrefix(suiteId)
  const k = artifact ? _sideHarvestMetrics(artifact, 'K') : null
  const n = artifact && _controlCollected(artifact) ? _sideHarvestMetrics(artifact, 'N') : null
  const deltaS =
    k?.success != null && n?.success != null ? k.success - n.success : null

  lines.push(`%% ── suite ${suiteId} ──`)
  if (!artifact) {
    lines.push(_texMacro(`${prefix}RunId`, '---'))
    lines.push(_texMacro(`${prefix}RunDate`, 'no scored run found'))
    lines.push(_texMacro(`${prefix}Target`, _suiteTargetLabel(suiteId, null)))
    lines.push(_texMacro(`${prefix}ControlCollected`, 'no'))
    lines.push(_texMacro(`${prefix}DeltaS`, '---'))
    lines.push('')
    return
  }

  lines.push(_texMacro(`${prefix}RunId`, _texEscape(artifact.run_label ?? artifact.run?.run_name ?? '---')))
  lines.push(_texMacro(`${prefix}RunDate`, _formatRunDate(artifact.created_at)))
  lines.push(_texMacro(`${prefix}Target`, _suiteTargetLabel(suiteId, artifact)))
  lines.push(
    _texMacro(`${prefix}ControlCollected`, _controlCollected(artifact) ? 'yes' : 'no')
  )
  lines.push(_texMacro(`${prefix}ControlAgent`, _texEscape(_controlAgentLabel(artifact))))
  lines.push(_texMacro(`${prefix}DeltaS`, _texSigned(deltaS)))

  for (const [side, m] of [
    ['K', k],
    ['N', n],
  ]) {
    lines.push(_texMacro(`${prefix}${side}S`, _texNum(m?.success)))
    lines.push(_texMacro(`${prefix}${side}Qadeq`, _texNum(m?.quality)))
    lines.push(_texMacro(`${prefix}${side}Etok`, _texNum(m?.tokenEfficiency)))
    lines.push(_texMacro(`${prefix}${side}Espeed`, _texNum(m?.speed)))
    lines.push(_texMacro(`${prefix}${side}Pass`, _texNum(m?.pass)))
    lines.push(_texMacro(`${prefix}${side}Correctness`, _texNum(m?.correctness, 3)))
    lines.push(_texMacro(`${prefix}${side}Usefulness`, _texNum(m?.usefulness, 3)))
    lines.push(_texMacro(`${prefix}${side}Relevance`, _texNum(m?.relevance, 3)))
    lines.push(_texMacro(`${prefix}${side}Tokens`, _texInt(m?.weightedTokens)))
    lines.push(_texMacro(`${prefix}${side}DurationSec`, _texDurationSec(m?.durationMs)))
    lines.push(_texMacro(`${prefix}${side}Docs`, _texInt(m?.docs)))
    lines.push(_texMacro(`${prefix}${side}Entities`, _texInt(m?.entities)))
    lines.push(_texMacro(`${prefix}${side}Rels`, _texInt(m?.relationships)))
  }
  lines.push('')
}

/**
 * Regenerate research/tables/results.tex from the latest scored harvest artifacts.
 * Called after eval runs and via `pnpm run research:results`.
 */
export function writeResearchResultsTex(repoRoot, options = {}) {
  const suites = options.suites ?? RESEARCH_RESULT_SUITES
  const outPath =
    options.outPath ?? path.join(repoRoot, 'research', 'tables', 'results.tex')

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

  const allHaveControl = suites.every(id => {
    const a = suiteArtifacts[id]
    return a && _controlCollected(a)
  })
  const anyHaveControl = suites.some(id => {
    const a = suiteArtifacts[id]
    return a && _controlCollected(a)
  })

  let controlStatus
  if (allHaveControl) {
    controlStatus = 'paired K-vs-N harvest runs collected for both \\texttt{kb} and \\texttt{raylib} suites (\\ResultsUpdated)'
  } else if (anyHaveControl) {
    const missing = suites
      .filter(id => {
        const a = suiteArtifacts[id]
        return !a || !_controlCollected(a)
      })
      .map(id => `\\texttt{${id}}`)
      .join(' and ')
    controlStatus = `control side missing or incomplete for ${missing}; see Table~\\ref{tab:harvest-results}`
  } else {
    controlStatus =
      'no paired control runs in the latest scored artifacts; run \\texttt{pnpm run eval -- --auto-score} with a control agent'
  }

  const lines = [
    '% Auto-generated by writeResearchResultsTex — do not edit by hand.',
    '% Regenerated after eval harvest runs and via `pnpm run research:results`.',
    '',
    _texMacro('ResultsUpdated', _formatRunDate(dated ?? new Date().toISOString())),
    _texMacro('ResultsJudge', _texEscape(_judgeLabel(judgeArtifact))),
    _texMacro('ResultsControlStatus', controlStatus),
    '',
  ]

  for (const suiteId of suites) {
    _emitSuiteResults(lines, suiteId, suiteArtifacts[suiteId])
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
      console.log(' TELEMETRY (8 questions)')
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
