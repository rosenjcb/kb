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

export function parseQueryText(text) {
  let answer = null
  const sepIdx = text.indexOf('\n---\n')
  if (sepIdx !== -1) {
    const beforeSep = text.slice(0, sepIdx)
    const lastDoneIdx = beforeSep.lastIndexOf('\nstage> answer')
    if (lastDoneIdx !== -1) {
      const lineEnd = beforeSep.indexOf('\n', lastDoneIdx + 1)
      if (lineEnd !== -1) answer = beforeSep.slice(lineEnd + 1).trim()
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
// Artifact metric accessors
// ---------------------------------------------------------------------------

export function scoreMetric(artifact, key) {
  const q = artifact?.aggregate_scores?.query
  const c = artifact?.aggregate_scores?.combined
  if (key === 'usefulness') return q?.mean_usefulness ?? c?.mean_usefulness ?? null
  if (key === 'pass_rate')
    return (
      q?.pass_rate_correctness_and_usefulness_at_least_3 ??
      c?.pass_rate_correctness_and_usefulness_at_least_3 ??
      null
    )
  if (key === 'correctness') return q?.mean_correctness ?? c?.mean_correctness ?? null
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
    pass: q.pass_rate_correctness_and_usefulness_at_least_3 ?? null,
    correctness: q.mean_correctness ?? null,
    usefulness: q.mean_usefulness ?? null,
    specificity: q.mean_specificity ?? null,
    evidence: q.mean_evidence_handling ?? null,
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
  console.log('')
  console.log(_summaryLine('═'))
  console.log(` eval summary · suite=${suiteId} · ${runLabel}`)
  console.log(_summaryLine('═'))

  if (ctrlForCompare && kbScores) {
    const delta = k => {
      const a = kbScores[k]
      const b = ctrlForCompare[k]
      return typeof a === 'number' && typeof b === 'number' ? a - b : null
    }
    console.log('')
    console.log(' THIS RUN — kb vs control')
    console.log('              pass    corr     use')
    console.log(
      ` control   ${_padScore(ctrlForCompare.pass)}  ${_padScore(ctrlForCompare.correctness)}  ${_padScore(ctrlForCompare.usefulness)}`
    )
    console.log(
      ` kb        ${_padScore(kbScores.pass)}  ${_padScore(kbScores.correctness)}  ${_padScore(kbScores.usefulness)}`
    )
    console.log(
      ` Δ kb−ctrl ${formatScoreDelta(delta('pass'))}  ${formatScoreDelta(delta('correctness'))}  ${formatScoreDelta(delta('usefulness'))}`
    )
    console.log(` verdict   ${kbControlVerdict(kbScores, ctrlForCompare)}`)

    if (sameRunControl && currentArtifact?.query_evaluation?.length) {
      const worst = worstQuestionGaps(
        currentArtifact.query_evaluation,
        sameRunControl.query_evaluation,
        currentArtifact.question_set,
        3
      ).filter(g => g.gap < 0)
      if (worst.length) {
        console.log('')
        console.log(' WEAKEST (corr gap, kb − control)')
        for (const g of worst) {
          console.log(
            `   Q${g.q}  ${g.topic.padEnd(42)}  kb=${g.kb.toFixed(1)}  ctrl=${g.ctrl.toFixed(1)}  Δ=${formatScoreDelta(g.gap).trim()}`
          )
        }
      }
    }

    const tel = currentArtifact?.comparison?.control_efficiency
    if (tel?.total_cost_usd != null) {
      console.log(
        ` control cost  $${Number(tel.total_cost_usd).toFixed(2)} · ${tel.mean_num_turns ?? '?'} turns/q`
      )
    }
  } else if (kbScores) {
    console.log('')
    console.log(' THIS RUN — kb only (no control in artifact)')
    console.log(
      ` pass=${_padScore(kbScores.pass).trim()}  corr=${_padScore(kbScores.correctness).trim()}  use=${_padScore(kbScores.usefulness).trim()}`
    )
  }

  const kbHistory = kbs.slice(-12)
  if (kbHistory.length >= 2) {
    const corrSeries = kbHistory.map(r => r.correctness)
    const passSeries = kbHistory.map(r => r.pass_rate)
    console.log('')
    console.log(' KB TREND (last runs)')
    console.log(` corr  ${sparkline(corrSeries)}  ${_trendNote(corrSeries)}`)
    console.log(` pass  ${sparkline(passSeries)}  ${_trendNote(passSeries)}`)
  }

  const recent = filtered.slice(-14)
  const W = 22
  console.log('')
  console.log(' RECENT RUNS')
  console.log(
    `${'date'.padEnd(17)} ${'who'.padEnd(7)} ${'pass'.padStart(6)} ${'corr'.padStart(6)} ${'use'.padStart(6)}  run`
  )
  console.log(_summaryLine())
  for (const r of recent) {
    const dt = r.created ? String(r.created).slice(0, 16).replace('T', ' ') : 'unknown'
    const marker = r.id === runLabel || r.id === `${runLabel} [control]` ? ' ←' : ''
    const id =
      r.id.length > W ? `${r.id.slice(0, W - 1)}…` : r.id
    console.log(
      `${dt.padEnd(17)} ${r.cond.padEnd(7)} ${_padScore(r.pass_rate)} ${_padScore(r.correctness)} ${_padScore(r.usefulness)}  ${id}${marker}`
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
