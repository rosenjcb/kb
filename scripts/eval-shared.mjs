/**
 * Shared utilities used by both eval-run.mjs and moel-run.mjs.
 * Do not duplicate these in either script — import from here.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    'about', 'after', 'again', 'also', 'another', 'before', 'between',
    'could', 'does', 'every', 'first', 'found', 'given', 'having',
    'hours', 'large', 'later', 'might', 'never', 'often', 'other',
    'place', 'small', 'since', 'still', 'their', 'there', 'these',
    'thing', 'think', 'those', 'three', 'under', 'until', 'using',
    'value', 'which', 'while', 'whose', 'would',
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
