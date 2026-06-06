#!/usr/bin/env node
/**
 * Unified kb eval harvest: run 8× `kb query` against a KB session and record results.
 * Layout: `~/.kb/evaluations/<run-name>/` contains `<repo-name>/` clone + artifacts.
 *
 * Session lifecycle is fully automatic:
 *   - Base name is derived from the suite id: `eval-{suiteId}` (e.g. `eval-raylib`, `eval-kb`).
 *   - If the session already has docs → reuse it (query-only run).
 *   - If the session is empty / missing → run `kb init` first, then query.
 *   - `--base NAME` overrides the formula. `--force-init` forces re-init even if docs exist.
 * Ends with an automatic trends summary across prior runs for the same suite.
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/eval-run.mjs --suite raylib [--auto-score]
 *   node scripts/eval-run.mjs --suite kb
 *   node scripts/eval-run.mjs --suite generic --repo https://github.com/org/repo.git
 *   node scripts/eval-run.mjs --suite raylib --base my-session   # override session name
 *   node scripts/eval-run.mjs --suite raylib --force-init        # re-init even if session exists
 *
 * Suites: vendor id → `eval/suites/<id>.yaml` (raylib, kb, generic). `--suite-yaml PATH` for custom.
 * Clone: suite YAML repo_url used by default; override with `--repo <git-url>`.
 */

import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const SUITES_DIR = path.join(KB_REPO, 'eval', 'suites')

function listSuiteIds() {
  if (!fs.existsSync(SUITES_DIR)) return []
  return fs
    .readdirSync(SUITES_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.basename(f).replace(/\.(yaml|yml)$/i, ''))
}

/**
 * @returns {{ id: string, questions: string[], answers: string[] | null, rubricPhrase: string, sourceFile: string, repoUrl: string | null }}
 */
function normalizeSuiteDoc(raw, sourceFile) {
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
  }
}

function evaluationsRoot() {
  return path.join(os.homedir(), '.kb', 'evaluations')
}

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

/**
 * Run folder basename == default KB `--base` for `all` mode: `<repoLeaf>-YYYY-MM-DD-HHmm`.
 * Suffix `-2`, `-3`, … if that name is already taken (same-minute rerun).
 */
function allocateRunName(repoLeaf) {
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

function loadVendorSuite(suiteId) {
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

function loadSuiteFromPath(absPath) {
  const resolved = path.resolve(absPath)
  if (!fs.existsSync(resolved)) throw new Error(`[eval] --suite-yaml not found: ${resolved}`)
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'))
  return normalizeSuiteDoc(raw, resolved)
}

function parseArgs(argv) {
  // Accept optional legacy mode positional (init/all/query) for backward compat
  const legacyModes = new Set(['init', 'all', 'query'])
  const first = argv[2]
  const hasLegacyMode = first && !first.startsWith('-') && legacyModes.has(first)
  const out = {
    // init/all legacy → treat as --force-init; query legacy → no-op
    forceInit: first === 'init' || first === 'all',
    suite: null,
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
    autoScore: true, // on by default; disable with --manual-score
    autoScoreFile: null,
    help: false,
  }
  let i = hasLegacyMode ? 3 : 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--suite') out.suite = argv[++i]
    else if (a === '--suite-yaml') out.suiteYaml = argv[++i]
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
    else if (a === '--manual-score') out.autoScore = false
    else if (a === '--skip-init') out.skipCapture = true
    else if (a === '--force-init') out.forceInit = true
    else if (a === '--help' || a === '-h') out.help = true
    i++
  }
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
  npm run eval -- --suite raylib [--auto-score]

Session lifecycle (automatic):
  Base is derived as eval-{suiteId} (e.g. eval-raylib, eval-kb).
  If the session has docs → reuse it (query-only run).
  If the session is empty / missing → kb init first, then query.
  Ends with a trends summary across prior runs for the same suite.

Suite / questions:
  --suite VENDOR          Load eval/suites/VENDOR.yaml  (raylib, kb, fzf, generic)
  --suite-yaml PATH       Load pack from arbitrary YAML path
  --questions-file F.json Override: JSON array of exactly 8 strings

Session:
  --base NAME             Override derived session name (default: eval-{suiteId})
  --force-init            Re-init even if session already has docs

Target repo (for clone + git metadata):
  --repo URL              Override suite YAML repo_url (https or git@)
  --clone-branch BR
  --clone-depth N         Shallow depth (default 1; use 0 for full clone)

Output:
  --label SLUG            Stored as run_label in artifact
  --out PATH              Override artifact JSON path
  --manual-score          Skip LLM auto-scoring (default: auto-score is ON)
  --scores-file PATH      Load manual rubric scores instead (JSON array of 8)
  --auto-score-file PATH  Write auto-scores to a specific path

Advanced:
  --run-dir PATH          With --skip-init: reuse existing scratch dir
  --skip-init             Skip all kb commands; re-score existing q*.json
  --hypothesis TEXT

Layout (per run, snapshot clone):
  ~/.kb/evaluations/<run-name>/<repo-name>/  git clone
  ~/.kb/evaluations/<run-name>/              scratch (q*.json, logs) + artifact.json
`)
}

function kbEnv() {
  const env = { ...process.env }
  env.KB_HOME = undefined
  return env
}

function kb(cwd, args, opts = {}) {
  const bin = path.join(KB_REPO, 'dist/bin/kb.js')
  return execSync(`node "${bin}" ${args}`, {
    encoding: 'utf8',
    env: kbEnv(),
    cwd,
    maxBuffer: 50 * 1024 * 1024,
    stdio: opts.capture === false ? 'inherit' : undefined,
    ...opts,
  })
}

export function stripCliBanner(text) {
  const i = text.indexOf('{')
  if (i === -1) return text.trim()
  return text.slice(i)
}

/** Deterministic session name from suite id: eval-{suiteId} */
export function derivedBase(suiteId) {
  return `eval-${sanitizeSlugPart(suiteId)}`
}

/** Returns true if the KB session already has at least one document. */
function sessionHasDocs(targetCwd, base) {
  try {
    const out = kb(targetCwd, `docs list --base ${base}`)
    const m = /Count:\s*(\d+)/.exec(out)
    return m ? Number(m[1]) > 0 : false
  } catch {
    return false
  }
}

/**
 * Parse the text output of `kb query` into a normalized object.
 * kb query does not support --output json; this handles the prose format.
 */
export function parseQueryText(text) {
  // The output has multiple answer rounds (answer:done, answer-r2:done, answer-r3:done).
  // The final comprehensive answer is always between the last "stage> answer*:done Xms" line
  // and the "---" separator that precedes the evidence/retrieval footer.
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

function readQueryResult(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return parseQueryText(raw)
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

export function parseGraphCounts(graphText) {
  // kb graph outputs "Triplets:" and "Symbols:" (not "Entities:"/"Relationships:")
  const em = /Triplets:\s*(\d+)/.exec(graphText) ?? /Entities:\s*(\d+)/.exec(graphText)
  const rm = /Symbols:\s*(\d+)/.exec(graphText) ?? /Relationships:\s*(\d+)/.exec(graphText)
  return {
    entities: em ? Number(em[1]) : 0,
    relationships: rm ? Number(rm[1]) : 0,
  }
}

function parseLatestInitRunId(logsText) {
  const lines = logsText.split('\n').filter(l => l.trim().startsWith('run-'))
  if (lines.length === 0) return null
  const first = lines[0].trim().split(/\s+/)[0]
  return first || null
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

function deriveCoverageFacets(question) {
  const stopWords = new Set([
    'what',
    'where',
    'when',
    'which',
    'who',
    'why',
    'how',
    'does',
    'do',
    'did',
    'the',
    'and',
    'for',
    'with',
    'from',
    'into',
    'about',
    'that',
    'this',
    'these',
    'those',
    'main',
    'including',
    'recent',
    'someone',
    'project',
    'repo',
  ])
  const tokens = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 3 && !stopWords.has(token))
  return [...new Set(tokens)].slice(0, 8)
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

function clipText(s, maxLen) {
  if (typeof s !== 'string' || !s) return ''
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}\n…[truncated]`
}

function clampScore0to4(x) {
  const n = Math.round(Number(x))
  if (!Number.isFinite(n)) return 0
  return Math.min(4, Math.max(0, n))
}

function parseJsonObjectFromLLM(text) {
  const trimmed = String(text).trim()
  const tryParse = s => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let o = tryParse(trimmed)
  if (o && typeof o === 'object') return o
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed)
  if (fence) {
    o = tryParse(fence[1].trim())
    if (o && typeof o === 'object') return o
  }
  const i = trimmed.indexOf('{')
  const j = trimmed.lastIndexOf('}')
  if (i !== -1 && j > i) {
    o = tryParse(trimmed.slice(i, j + 1))
    if (o && typeof o === 'object') return o
  }
  // Also try extracting a bare JSON array
  const ai = trimmed.indexOf('[')
  const aj = trimmed.lastIndexOf(']')
  if (ai !== -1 && aj > ai) {
    o = tryParse(trimmed.slice(ai, aj + 1))
    if (Array.isArray(o)) return o
  }
  throw new Error(
    `[eval] Auto-score: could not parse JSON from model (prefix): ${trimmed.slice(0, 500)}`
  )
}

function buildRubric(phrase, hasReferenceAnswers = false) {
  const referenceNote = hasReferenceAnswers
    ? '\n\nA reference answer is provided for each question. Use it as a factual ground-truth to assess correctness — if the actual answer contradicts or omits key facts present in the reference, lower the Correctness score accordingly. The reference answer is not a style template; answers that cover the same facts differently are still correct.'
    : ''
  return `You score kb \`query\` answers for ${phrase}. Each axis must be an integer 0–4.

Correctness — 4: factually correct and grounded in the supplied answer/evidence; 3: mostly correct; 2: mixed or meaningful inaccuracies; 1: mostly wrong; 0: no useful answer.
Usefulness — 4: directly helps a developer act or understand the system; 3: helpful but incomplete; 2: some signal, needs substantial follow-up; 1: barely helpful; 0: not helpful.
Specificity — 4: concrete project-specific APIs, paths, build flags, or mechanisms; 3: some concrete detail; 2: partly generic; 1: mostly generic; 0: purely generic or evasive.
Evidence handling — 4: clearly tied to evidence, acknowledges gaps; 3: reasonably grounded; 2: some speculation; 1: strong speculation or unsupported claims; 0: no evidence discipline.

Penalize boilerplate-only answers, stub lines that are not real explanations, and answers that miss the core of the question even if retrieval metadata looks confident.${referenceNote}`
}

async function callGeminiJudgeJson({ apiKey, model, systemInstruction, userText }) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) {
    const msg = data?.error?.message || response.statusText
    throw new Error(`[eval] Gemini judge failed (${response.status}): ${msg}`)
  }
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) {
    throw new Error('[eval] Gemini judge: empty candidates/parts')
  }
  return parts
    .filter(p => p && typeof p.text === 'string' && p.thought !== true)
    .map(p => p.text)
    .join('')
}

async function callOpenAIJudgeJson({ apiKey, model, systemInstruction, userText }) {
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText },
    ],
  }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) {
    const msg = data?.error?.message || response.statusText
    throw new Error(`[eval] OpenAI judge failed (${response.status}): ${msg}`)
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('[eval] OpenAI judge: missing message content')
  }
  return content
}

async function runAutoScoreFile({ workdir, questions, answers, outScoresPath, rubricPhrase }) {
  const hasRef = Array.isArray(answers) && answers.length === questions.length
  const RUBRIC = buildRubric(rubricPhrase, hasRef)
  const blocks = questions.map((q, i) => {
    const parsed = readQueryResult(path.join(workdir, `q${i + 1}.json`))
    const ans = parsed.answer || ''
    const prov = parsed.provenance
    const ret = parsed.retrieval
    const refSection = hasRef ? `\nReference answer:\n${clipText(answers[i], 3000)}\n` : ''
    return `### Question ${i + 1}\n${q}\n\nRetrieval (summary): ${clipText(JSON.stringify(ret), 2000)}\nProvenance ids: ${JSON.stringify(prov)}\n${refSection}\nAnswer:\n${clipText(ans, 6000)}\n`
  })

  const schemaHint = `Return a single JSON object with exactly one key "scores" whose value is an array of exactly 8 objects in question order (index 0 = question 1). Each object must have: "correctness", "usefulness", "specificity", "evidence_handling" (integers 0-4) and "notes" (short string rationale). No markdown fences.`

  const systemInstruction = `${RUBRIC}\n\n${schemaHint}`
  const userText = `Score these 8 kb query question/answer pairs.\n\n${blocks.join('\n---\n')}`

  const geminiKey = process.env.GEMINI_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  let rawJsonText
  let providerUsed
  let modelUsed

  if (geminiKey) {
    providerUsed = 'gemini'
    modelUsed = process.env.EVAL_SCORER_MODEL || 'gemini-2.5-flash'
    rawJsonText = await callGeminiJudgeJson({
      apiKey: geminiKey,
      model: modelUsed,
      systemInstruction,
      userText,
    })
  } else if (openaiKey) {
    providerUsed = 'openai'
    modelUsed = process.env.EVAL_SCORER_OPENAI_MODEL || 'gpt-4o-mini'
    rawJsonText = await callOpenAIJudgeJson({
      apiKey: openaiKey,
      model: modelUsed,
      systemInstruction,
      userText,
    })
  } else {
    throw new Error(
      '[eval] --auto-score requires GEMINI_API_KEY or OPENAI_API_KEY (same keys as kb init).'
    )
  }

  let obj = parseJsonObjectFromLLM(rawJsonText)
  // Handle model returning a bare array instead of { scores: [...] }
  if (Array.isArray(obj)) obj = { scores: obj }
  const scores = obj.scores
  if (!Array.isArray(scores) || scores.length !== 8) {
    throw new Error(
      `[eval] Auto-score: expected { "scores": [ ... 8 items ] }, got keys=${Object.keys(obj).join(',')}`
    )
  }

  const normalized = scores.map((row, idx) => ({
    correctness: clampScore0to4(row.correctness),
    usefulness: clampScore0to4(row.usefulness),
    specificity: clampScore0to4(row.specificity),
    evidence_handling: clampScore0to4(row.evidence_handling),
    notes:
      typeof row.notes === 'string' && row.notes.trim()
        ? row.notes.trim()
        : `Auto-score question ${idx + 1} (${providerUsed})`,
  }))

  fs.mkdirSync(path.dirname(path.resolve(outScoresPath)), { recursive: true })
  fs.writeFileSync(path.resolve(outScoresPath), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  console.error(
    `[eval] auto-score wrote ${path.resolve(outScoresPath)} (${providerUsed}/${modelUsed})`
  )

  return { normalized, providerUsed, modelUsed, outScoresPath: path.resolve(outScoresPath) }
}

/** Fresh snapshot clone: removes dest if present. */
function gitCloneSnapshot({ url, dest, branch, depth }) {
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
    if (!Array.isArray(qs) || qs.length !== 8 || !qs.every(x => typeof x === 'string')) {
      throw new Error('--questions-file must be a JSON array of exactly 8 strings')
    }
    return qs
  }
  return suiteConfig.questions
}

/** kb logs list does not filter by base; init runs still show up in global telemetry. */
function logsCmd(evalMode) {
  if (evalMode === 'query') return 'logs list --limit 5'
  return 'logs list --command init --limit 3'
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

// ── Trends summary (absorbed from eval-trends.mjs) ──────────────────────────

function _safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

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

function _fmtN(n) {
  if (n === null || n === undefined) return '  -'
  if (Number.isInteger(n)) return String(n).padStart(3)
  return n.toFixed(1).padStart(5)
}

function _fmtScore(n) {
  return n === null || n === undefined ? '  -  ' : n.toFixed(3)
}
function _delta(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? a - b : null
}
function _fmtDelta(n) {
  if (n === null) return '  -  '
  return (n >= 0 ? '+' : '') + n.toFixed(3)
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

function printTrendsSummary(suiteId) {
  const repoRoot = KB_REPO
  const all = _gatherArtifacts(repoRoot)
  const filtered = all
    .filter(row => matchesSuite(row, suiteId))
    .map(row => ({
      ...row,
      created: row.artifact?.created_at ?? null,
      docs: structuralMetric(row.artifact, 'docs'),
      entities: structuralMetric(row.artifact, 'entities'),
      rels: structuralMetric(row.artifact, 'rels'),
      avg_results: structuralMetric(row.artifact, 'avg_results'),
      usefulness: scoreMetric(row.artifact, 'usefulness'),
      pass_rate: scoreMetric(row.artifact, 'pass_rate'),
      correctness: scoreMetric(row.artifact, 'correctness'),
    }))
    .filter(row => row.docs !== null || row.entities !== null || row.avg_results !== null)
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

  const last = filtered[filtered.length - 1]
  const prev = filtered.length > 1 ? filtered[filtered.length - 2] : null
  const first = filtered[0]
  const scoredRuns = filtered.filter(
    r =>
      typeof r.usefulness === 'number' && (r.usefulness > 0 || r.pass_rate > 0 || r.correctness > 0)
  )

  console.log(
    `\n[eval-trends] suite=${suiteId}  runs=${filtered.length}  scored=${scoredRuns.length}`
  )
  console.log(
    `[eval-trends] latest  docs=${_fmtN(last.docs).trim()} entities=${_fmtN(last.entities).trim()} rels=${_fmtN(last.rels).trim()} avg_results=${last.avg_results !== null ? last.avg_results.toFixed(1) : '-'}`
  )
  if (scoredRuns.length) {
    const sl = scoredRuns[scoredRuns.length - 1]
    console.log(
      `[eval-trends] latest (scored)  use=${_fmtScore(sl.usefulness)} pass=${_fmtScore(sl.pass_rate)} corr=${_fmtScore(sl.correctness)}`
    )
  }
  if (prev) {
    console.log(
      `[eval-trends] delta(prev→latest)  docs=${_fmtDelta(_delta(last.docs, prev.docs))} entities=${_fmtDelta(_delta(last.entities, prev.entities))} avg_results=${_fmtDelta(_delta(last.avg_results, prev.avg_results))}`
    )
  }
  console.log(
    `[eval-trends] delta(first→latest)  docs=${_fmtDelta(_delta(last.docs, first.docs))} entities=${_fmtDelta(_delta(last.entities, first.entities))}`
  )

  const entitiesSpark = sparkline(filtered.map(r => r.entities))
  const resultsSpark = sparkline(filtered.map(r => r.avg_results))
  const useSpark = sparkline(scoredRuns.map(r => r.usefulness))
  if (entitiesSpark) console.log(`[eval-trends] entities trend    ${entitiesSpark}`)
  if (resultsSpark) console.log(`[eval-trends] avg-results trend ${resultsSpark}`)
  if (useSpark) console.log(`[eval-trends] usefulness trend  ${useSpark}`)

  const W = 26
  const hdr = `\n${'date'.padEnd(20)} ${'run'.padEnd(W)} ${'docs'.padStart(4)} ${'ent'.padStart(5)} ${'rels'.padStart(5)} ${'res'.padStart(5)} ${'use'.padStart(6)} ${'pass'.padStart(6)} ${'corr'.padStart(6)}  src`
  console.log(hdr)
  console.log('-'.repeat(hdr.trim().length))
  for (const r of filtered) {
    const d = r.created ? String(r.created).slice(0, 19) : 'unknown             '
    const id = r.id.length > W ? `${r.id.slice(0, W - 1)}…` : r.id.padEnd(W)
    console.log(
      [
        d,
        id,
        _fmtN(r.docs),
        _fmtN(r.entities),
        _fmtN(r.rels),
        _fmtN(r.avg_results),
        _fmtScore(r.usefulness),
        _fmtScore(r.pass_rate),
        _fmtScore(r.correctness),
        ` ${r.source}`,
      ].join(' ')
    )
  }
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
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.suiteYaml && args.suite) {
    console.error('[eval] use only one of --suite and --suite-yaml')
    process.exit(1)
  }
  if (!args.suiteYaml && !args.suite) {
    console.error(
      `[eval] require --suite <vendor> or --suite-yaml <path.yaml> (vendors: ${listSuiteIds().join(', ')})`
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
  if (!args.repo && suiteConfig.repoUrl) {
    args.repo = suiteConfig.repoUrl
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

  // Auto-detect whether init is needed: session missing docs → init; existing docs → query only
  const needsInit = !args.skipCapture && (args.forceInit || !sessionHasDocs(targetCwd, base))
  const evalMode = needsInit ? 'all' : 'query'

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

  const kbBin = path.join(KB_REPO, 'dist/bin/kb.js')
  if (!fs.existsSync(kbBin)) {
    console.error('Missing dist/bin/kb.js — run: pnpm run build')
    process.exit(1)
  }

  if (!args.skipCapture) {
    console.error(`[eval] workdir ${workdir}`)
    console.error(`[eval] target cwd ${targetCwd}`)
    console.error(
      `[eval] base "${base}" — ${needsInit ? 'no docs found, running kb init' : 'session exists, reusing'}`
    )

    if (needsInit) {
      const initLog = kb(targetCwd, `init --base ${base} --non-interactive --debug`)
      fs.writeFileSync(path.join(workdir, 'init.log'), initLog, 'utf8')
    } else {
      fs.writeFileSync(
        path.join(workdir, 'init.log'),
        `{"note":"query_only_mode","base":"${base}"}\n`,
        'utf8'
      )
    }

    console.error(`[eval] kb default ${base}`)
    kb(targetCwd, `default ${base}`, { stdio: 'inherit' })

    console.error('[eval] docs list')
    const docsOut = kb(targetCwd, `docs list --base ${base}`)
    fs.writeFileSync(path.join(workdir, 'docs.txt'), docsOut, 'utf8')

    console.error('[eval] graph')
    const graphOut = kb(targetCwd, `graph --base ${base}`)
    fs.writeFileSync(path.join(workdir, 'graph.txt'), graphOut, 'utf8')

    console.error('[eval] logs list')
    const logsOut = kb(targetCwd, logsCmd(evalMode))
    fs.writeFileSync(path.join(workdir, 'logs.txt'), logsOut, 'utf8')

    let q = 1
    for (const question of questions) {
      console.error(`[eval] query ${q}/8`)
      const escaped = question.replace(/"/g, '\\"')
      const out = kb(targetCwd, `query "${escaped}" --base ${base}`)
      fs.writeFileSync(path.join(workdir, `q${q}.json`), out, 'utf8')
      q++
    }
  }

  const initLogText = fs.readFileSync(path.join(workdir, 'init.log'), 'utf8')
  const initJson = evalMode === 'all' ? extractInitAcceptedObject(initLogText) : null
  const graphText = fs.readFileSync(path.join(workdir, 'graph.txt'), 'utf8')
  const graphCounts = parseGraphCounts(graphText)
  const logsText = fs.readFileSync(path.join(workdir, 'logs.txt'), 'utf8')
  const initRunId = parseLatestInitRunId(logsText)
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
    if (!Array.isArray(manualScores) || manualScores.length !== 8) {
      console.error('--scores-file must be a JSON array of length 8')
      process.exit(1)
    }
  } else if (args.autoScore) {
    const outScores = args.autoScoreFile || path.join(workdir, 'auto-scores.json')
    try {
      const res = await runAutoScoreFile({
        workdir,
        questions,
        answers: suiteConfig?.answers ?? null,
        outScoresPath: outScores,
        rubricPhrase,
      })
      manualScores = res.normalized
      queryScoringMeta = {
        mode: 'llm_judge_single_shot',
        provider: res.providerUsed,
        model: res.modelUsed,
        scores_file: res.outScoresPath,
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    }
  }

  const query_evaluation = []
  for (let n = 1; n <= 8; n++) {
    const parsed = readQueryResult(path.join(workdir, `q${n}.json`))
    const { answer, result_count, provenance: prov, retrieval } = parsed
    const coverageAudit = buildCoverageAudit(questions[n - 1], answer, retrieval.detail)

    const ms = manualScores?.[n - 1]
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
  const mS = mean(query_evaluation.map(q => q.scores.specificity))
  const mE = mean(query_evaluation.map(q => q.scores.evidence_handling))
  const pr =
    query_evaluation.filter(q => q.scores.correctness >= 3 && q.scores.usefulness >= 3).length /
    query_evaluation.length
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
    schema_version: 1,
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
        repoUrl ? `git clone (snapshot) → ${targetCwd}` : null,
        evalMode === 'all'
          ? `kb init --base ${base} --non-interactive --debug (cwd: ${targetCwd})`
          : null,
        `kb default ${base}`,
        `kb docs list --base ${base} --output json`,
        `kb graph --base ${base}`,
        `kb ${logsCmd(evalMode)}`,
        `kb query "<8 questions>" --base ${base} --output json`,
      ].filter(Boolean),
      workdir,
      run_dir: runDir,
      publish_dir: null,
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
    qualitative_findings: qualitative,
    next_improvement_areas: [
      'Optional: capture kb chat for status=complete per EVALUATION.md.',
      'Optional: read init token totals from ~/.kb/logs for init_result telemetry.',
    ],
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.error(`[eval] wrote ${outPath}`)

  printTrendsSummary(suiteId)
}

const _isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (_isMain) {
  main().catch(err => {
    console.error(err instanceof Error ? err.stack || err.message : err)
    process.exit(1)
  })
}
