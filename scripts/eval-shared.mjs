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
 * Print a trends table across prior runs for a suite. Rows are tagged with their
 * condition (control vs kb) so a control baseline and a KB run for the same suite
 * stay distinguishable. `repoRoot` is the kb repo root (for evaluation/runs/).
 */
export function printTrendsSummary(suiteId, repoRoot) {
  const all = _gatherArtifacts(repoRoot)
  // Each unified artifact yields a kb row (top-level scores) and, when present, a
  // nested control row (artifact.control) — so historic control-vs-kb stays comparable
  // even across runs where one side was skipped.
  const buildRow = (row, cond, data) => ({
    ...row,
    cond,
    created: row.artifact?.created_at ?? null,
    docs: structuralMetric(data, 'docs'),
    entities: structuralMetric(data, 'entities'),
    rels: structuralMetric(data, 'rels'),
    avg_results: structuralMetric(data, 'avg_results'),
    usefulness: scoreMetric(data, 'usefulness'),
    pass_rate: scoreMetric(data, 'pass_rate'),
    correctness: scoreMetric(data, 'correctness'),
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
    .slice(-20)

  if (filtered.length === 0) {
    console.log(`\n[eval-trends] no prior runs found for suite "${suiteId}"`)
    return
  }

  const controls = filtered.filter(r => r.cond === 'control')
  const kbs = filtered.filter(r => r.cond !== 'control')
  console.log(
    `\n[eval-trends] suite=${suiteId}  runs=${filtered.length}  kb=${kbs.length}  control=${controls.length}`
  )

  // Head-to-head: latest KB vs latest control (the control-vs-kb comparison).
  const latestKb = kbs[kbs.length - 1]
  const latestControl = controls[controls.length - 1]
  if (latestKb && latestControl) {
    const d = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null)
    const fmtD = n => (n === null ? '  -  ' : (n >= 0 ? '+' : '') + n.toFixed(3))
    console.log('[eval-trends] control vs kb (latest of each):')
    console.log(
      `[eval-trends]   pass   control=${_fmtScore(latestControl.pass_rate)} kb=${_fmtScore(latestKb.pass_rate)}  Δ(kb-control)=${fmtD(d(latestKb.pass_rate, latestControl.pass_rate))}`
    )
    console.log(
      `[eval-trends]   corr   control=${_fmtScore(latestControl.correctness)} kb=${_fmtScore(latestKb.correctness)}  Δ(kb-control)=${fmtD(d(latestKb.correctness, latestControl.correctness))}`
    )
    console.log(
      `[eval-trends]   use    control=${_fmtScore(latestControl.usefulness)} kb=${_fmtScore(latestKb.usefulness)}  Δ(kb-control)=${fmtD(d(latestKb.usefulness, latestControl.usefulness))}`
    )
  }

  const W = 24
  const hdr = `\n${'date'.padEnd(20)} ${'cond'.padEnd(7)} ${'run'.padEnd(W)} ${'docs'.padStart(4)} ${'ent'.padStart(5)} ${'res'.padStart(5)} ${'use'.padStart(6)} ${'pass'.padStart(6)} ${'corr'.padStart(6)}  src`
  console.log(hdr)
  console.log('-'.repeat(hdr.trim().length))
  for (const r of filtered) {
    const dt = r.created ? String(r.created).slice(0, 19) : 'unknown             '
    const id = r.id.length > W ? `${r.id.slice(0, W - 1)}…` : r.id.padEnd(W)
    console.log(
      [
        dt,
        r.cond.padEnd(7),
        id,
        _fmtN(r.docs),
        _fmtN(r.entities),
        _fmtN(r.avg_results),
        _fmtScore(r.usefulness),
        _fmtScore(r.pass_rate),
        _fmtScore(r.correctness),
        ` ${r.source}`,
      ].join(' ')
    )
  }
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
