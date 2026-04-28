#!/usr/bin/env node
/**
 * Unified kb eval harvest: **git URL only** (no local target cwd). Fresh clone per run = snapshot.
 * Layout: clone `~/.kb/evaluations/repos/<run-name>/`, scratch + default artifact `~/.kb/evaluations/<run-name>/`.
 * Default KB base for `all` == `<run-name>` (e.g. `raylib-2026-04-27-1303`); override with `--base`.
 * `all` (init + metrics + 8×query + jekyll publish) vs `query` (existing base only; still clones repo for cwd).
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/eval-run.mjs all --suite raylib --repo https://github.com/raysan5/raylib.git [--auto-score]
 *   node scripts/eval-run.mjs all --suite generic --repo https://github.com/org/repo.git
 *   node scripts/eval-run.mjs query --suite raylib --base dogfood --repo https://github.com/raysan5/raylib.git
 *
 * Suites: vendor id → `eval/suites/<id>.yaml` (raylib, kb, generic). `--suite-yaml PATH` for custom pack.
 * Clone: --repo URL (required unless --skip-init), [--clone-branch BR] [--clone-depth N default 1].
 * `all` runs `kb publish jekyll` into `<clone>/.docs/`.
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
 * @returns {{ id: string, questions: string[], rubricPhrase: string, graphWithBase: boolean, sourceFile: string }}
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
  const graphWithBase = raw.graph_with_base !== false
  return {
    id,
    questions: qs.map(s => s.trim()),
    rubricPhrase: rubric.trim(),
    graphWithBase,
    sourceFile,
  }
}

function evaluationsRoot() {
  return path.join(os.homedir(), '.kb', 'evaluations')
}

function reposEvalRoot() {
  return path.join(evaluationsRoot(), 'repos')
}

function sanitizeSlugPart(s) {
  const x = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return x || 'repo'
}

/** Short repo leaf name for artifact.repository.name (e.g. raylib). */
function repoLeafNameFromUrl(url) {
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
  const reposRoot = reposEvalRoot()
  let name = stem
  let n = 0
  while (fs.existsSync(path.join(root, name)) || fs.existsSync(path.join(reposRoot, name))) {
    n += 1
    name = `${stem}-${n}`
  }
  return name
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
  const mode = argv[2]
  const out = {
    mode: mode === 'query' ? 'query' : mode === 'all' ? 'all' : null,
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
    autoScore: false,
    autoScoreFile: null,
    help: false,
  }
  if (mode === '--help' || mode === '-h') out.help = true
  let i = 3
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
    else if (a === '--skip-init') out.skipCapture = true
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
      `[eval] removed flags: ${[...removed].join(', ')} — use --repo <git-url> (clone under ~/.kb/evaluations/repos/<run>/). Rebuild-only: --skip-init --run-dir ~/.kb/evaluations/<run>/`
    )
  }
}

function printHelp() {
  console.log(`eval-run.mjs — unified eval harvest (EVALUATION.md schema)

  node scripts/eval-run.mjs <all|query> --suite <vendor-id> --repo <git-url> [options]
  Vendor packs: eval/suites/<id>.yaml (e.g. raylib, kb, generic). Custom: --suite-yaml /path/to/pack.yaml

Modes:
  all     Fresh clone → kb init + docs + graph + logs + 8× query + jekyll → <clone>/.docs/
  query   Fresh clone → same capture minus init; requires --base (KB session must already exist)

Layout (per run, snapshot clone):
  ~/.kb/evaluations/repos/<run-name>/   git clone
  ~/.kb/evaluations/<run-name>/         scratch (q*.json, logs) + default artifact.json

Target:
  --repo URL              Git remote (https or git@); required unless --skip-init
  --clone-branch BR
  --clone-depth N         Shallow depth (default 1; use 0 for full clone)

Suite / questions:
  --suite VENDOR          Load eval/suites/VENDOR.yaml
  --suite-yaml PATH       Load pack from arbitrary YAML path
  --questions-file F.json Override: JSON array of exactly 8 strings (rubric still from suite YAML)

Other:
  --base NAME             Override KB base (all: default = run folder name, e.g. raylib-2026-04-27-1303; query: required)
  --label SLUG            Stored as run_label in artifact
  --run-dir PATH          With --skip-init: existing ~/.kb/evaluations/<run>/ scratch (expects repos/<same-name>/ clone)
  --out PATH              Override artifact JSON path
  --scores-file, --auto-score, --auto-score-file, --skip-init, --hypothesis
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

function stripCliBanner(text) {
  const i = text.indexOf('{')
  if (i === -1) return text.trim()
  return text.slice(i)
}

function parseJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return JSON.parse(stripCliBanner(raw))
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

function parseGraphCounts(graphText) {
  const em = /Entities:\s*(\d+)/.exec(graphText)
  const rm = /Relationships:\s*(\d+)/.exec(graphText)
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

function summarizeRaw(parsed) {
  const data = parsed.data ?? {}
  const results = data.results ?? []
  const ans =
    typeof parsed.answer === 'string'
      ? parsed.answer
      : typeof data.answer === 'string'
        ? data.answer
        : undefined
  return {
    status: parsed.status,
    result_count: results.length,
    retrieval: data.retrieval ?? null,
    answer_preview: typeof ans === 'string' ? ans.slice(0, 500) : null,
    provenance: Array.isArray(parsed.provenance) ? parsed.provenance : [],
  }
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function clipText(s, maxLen) {
  if (typeof s !== 'string' || !s) return ''
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}\n…[truncated]`
}

function extractAnswerFromQuery(parsed) {
  const data = parsed.data ?? {}
  if (typeof parsed.answer === 'string') return parsed.answer
  if (typeof data.answer === 'string') return data.answer
  return null
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
  throw new Error(
    `[eval] Auto-score: could not parse JSON from model (prefix): ${trimmed.slice(0, 500)}`
  )
}

function buildRubric(phrase) {
  return `You score kb \`query\` answers for ${phrase}. Each axis must be an integer 0–4.

Correctness — 4: factually correct and grounded in the supplied answer/evidence; 3: mostly correct; 2: mixed or meaningful inaccuracies; 1: mostly wrong; 0: no useful answer.
Usefulness — 4: directly helps a developer act or understand the system; 3: helpful but incomplete; 2: some signal, needs substantial follow-up; 1: barely helpful; 0: not helpful.
Specificity — 4: concrete project-specific APIs, paths, build flags, or mechanisms; 3: some concrete detail; 2: partly generic; 1: mostly generic; 0: purely generic or evasive.
Evidence handling — 4: clearly tied to evidence, acknowledges gaps; 3: reasonably grounded; 2: some speculation; 1: strong speculation or unsupported claims; 0: no evidence discipline.

Penalize boilerplate-only answers, stub lines that are not real explanations, and answers that miss the core of the question even if retrieval metadata looks confident.`
}

async function callGeminiJudgeJson({ apiKey, model, systemInstruction, userText }) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 8192,
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

async function runAutoScoreFile({ workdir, questions, outScoresPath, rubricPhrase }) {
  const RUBRIC = buildRubric(rubricPhrase)
  const blocks = questions.map((q, i) => {
    const parsed = parseJsonFile(path.join(workdir, `q${i + 1}.json`))
    const ans = extractAnswerFromQuery(parsed) || ''
    const data = parsed.data ?? {}
    const results = data.results ?? []
    const prov = Array.isArray(parsed.provenance)
      ? parsed.provenance
      : results.map(r => r.metadata?.id).filter(Boolean)
    const ret = data.retrieval ?? parsed.retrieval ?? null
    return `### Question ${i + 1}\n${q}\n\nRetrieval (summary): ${clipText(JSON.stringify(ret), 2000)}\nProvenance ids: ${JSON.stringify(prov)}\n\nAnswer:\n${clipText(ans, 6000)}\n`
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

  const obj = parseJsonObjectFromLLM(rawJsonText)
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
  const reposRoot = reposEvalRoot()

  if (args.skipCapture) {
    if (!args.runDir) {
      throw new Error(
        '[eval] --skip-init requires --run-dir ~/.kb/evaluations/<run-name>/ (scratch from a prior run)'
      )
    }
    const runDir = path.resolve(args.runDir)
    const runName = path.basename(runDir)
    const repoDir = path.join(reposRoot, runName)
    if (!fs.existsSync(runDir)) {
      throw new Error(`[eval] --run-dir not found: ${runDir}`)
    }
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      throw new Error(
        `[eval] expected clone at ${repoDir} (same basename as run dir) for kb commands / git metadata`
      )
    }
    return { runName, runDir, repoDir, targetCwd: repoDir, repoUrl: args.repo || null }
  }

  if (!args.repo || !String(args.repo).trim()) {
    throw new Error(
      '[eval] require --repo <git-url> (eval always clones under ~/.kb/evaluations/repos/<run>/)'
    )
  }

  const runName = allocateRunName(repoLeafNameFromUrl(args.repo))
  const runDir = path.join(root, runName)
  const repoDir = path.join(reposRoot, runName)
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(reposRoot, { recursive: true })
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

function graphCmd(base, graphWithBase) {
  return graphWithBase ? `graph --base ${base}` : 'graph'
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
  if (args.help || !args.mode) {
    printHelp()
    process.exit(args.help ? 0 : 1)
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

  if (args.mode === 'query' && !args.base) {
    console.error('[eval] mode query requires --base')
    process.exit(1)
  }

  const suiteId = suiteConfig.id

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

  let base = args.base
  if (!base && args.skipCapture) {
    const initLogPath = path.join(workdir, 'init.log')
    if (fs.existsSync(initLogPath)) base = readBaseFromInitLog(initLogPath)
  }
  if (!base && args.mode === 'all' && !args.skipCapture) base = runName
  if (!base) {
    console.error(
      '[eval] could not determine KB base — pass --base (for --skip-init, ensure init.log contains kb --base or query_only JSON)'
    )
    process.exit(1)
  }

  const label = args.label || runName
  const evalMode = args.mode

  const graphWithBase = suiteConfig.graphWithBase
  const hypothesis =
    args.hypothesis ||
    (repoUrl
      ? `Unified eval: clone ${repoUrl} → init + 8 queries (suite=${suiteId}).`
      : `Unified eval: suite=${suiteId}, run=${runName}, mode=${evalMode} (--skip-init).`)

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

  const publishDir = evalMode === 'all' ? path.join(targetCwd, '.docs') : null
  let publishNote = null

  if (!args.skipCapture) {
    console.error(`[eval] workdir ${workdir}`)
    console.error(`[eval] target cwd ${targetCwd}`)

    if (evalMode === 'all') {
      console.error(`[eval] init --base ${base}`)
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
    const docsOut = kb(targetCwd, `docs list --base ${base} --output json`)
    fs.writeFileSync(path.join(workdir, 'docs.json'), stripCliBanner(docsOut), 'utf8')

    console.error('[eval] graph')
    const graphOut = kb(targetCwd, graphCmd(base, graphWithBase))
    fs.writeFileSync(path.join(workdir, 'graph.txt'), graphOut, 'utf8')

    console.error('[eval] logs list')
    const logsOut = kb(targetCwd, logsCmd(evalMode))
    fs.writeFileSync(path.join(workdir, 'logs.txt'), logsOut, 'utf8')

    let q = 1
    for (const question of questions) {
      console.error(`[eval] query ${q}/8`)
      const escaped = question.replace(/"/g, '\\"')
      const out = kb(targetCwd, `query "${escaped}" --base ${base} --output json`)
      fs.writeFileSync(path.join(workdir, `q${q}.json`), out, 'utf8')
      q++
    }

    if (publishDir) {
      console.error(`[eval] publish jekyll -> ${publishDir}`)
      try {
        kb(targetCwd, `publish jekyll --base ${base} --dir ${publishDir}/ --apply`, {
          stdio: 'inherit',
        })
      } catch (e) {
        publishNote = e instanceof Error ? e.message : String(e)
        console.error(`[eval] publish failed: ${publishNote}`)
      }
    }
  }

  const initLogText = fs.readFileSync(path.join(workdir, 'init.log'), 'utf8')
  const initJson = evalMode === 'all' ? extractInitAcceptedObject(initLogText) : null
  const graphText = fs.readFileSync(path.join(workdir, 'graph.txt'), 'utf8')
  const graphCounts = parseGraphCounts(graphText)
  const logsText = fs.readFileSync(path.join(workdir, 'logs.txt'), 'utf8')
  const initRunId = parseLatestInitRunId(logsText)
  const docsList = parseJsonFile(path.join(workdir, 'docs.json'))

  if (args.scoresFile && args.autoScore) {
    console.error('[eval] Use only one of --scores-file and --auto-score / --auto-score-file.')
    process.exit(1)
  }

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
    const parsed = parseJsonFile(path.join(workdir, `q${n}.json`))
    const data = parsed.data ?? {}
    const results = data.results ?? []
    const retrieval = data.retrieval
      ? {
          method: data.retrieval.method ?? null,
          detail: data.retrieval.detail ?? null,
          confidence:
            data.retrieval.checkpoints?.[0]?.confidence ?? data.retrieval.confidence ?? null,
        }
      : { method: null, detail: null, confidence: null }
    const answer =
      typeof parsed.answer === 'string'
        ? parsed.answer
        : typeof data.answer === 'string'
          ? data.answer
          : null
    const prov = Array.isArray(parsed.provenance)
      ? parsed.provenance
      : results.map(r => r.metadata?.id).filter(Boolean)

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
      : 'Rubric scores not supplied — use EVALUATION.md, --scores-file, or --auto-score.'

    query_evaluation.push({
      question_id: n,
      question: questions[n - 1],
      result_count: results.length,
      retrieval,
      answer_excerpt: answer ? answer.slice(0, 280) : null,
      provenance: prov,
      raw_query_output: summarizeRaw(parsed),
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

  const outPath = args.outFile || path.join(runDir, 'artifact.json')

  const branch = git(targetCwd, 'branch --show-current')
  const commit = git(targetCwd, 'rev-parse HEAD')
  const repoName = repoUrl ? repoLeafNameFromUrl(repoUrl) : path.basename(repoDir)

  const qualitative = [
    queryScoringMeta
      ? `Query rubric: auto-scored (${queryScoringMeta.provider} ${queryScoringMeta.model}). Scores: ${queryScoringMeta.scores_file}.`
      : args.scoresFile
        ? `Scores loaded from --scores-file (${path.resolve(args.scoresFile)}).`
        : 'Query scores unset — pass --scores-file or --auto-score.',
    `eval_mode=${evalMode} suite=${suiteId} clone=${targetCwd}`,
    repoUrl ? `repo_url=${repoUrl}` : null,
    `Scratch + artifact under ${runDir}; snapshot clone under ${repoDir}`,
  ].filter(Boolean)
  if (publishNote) qualitative.push(`Jekyll publish note: ${publishNote}`)

  const initOk = evalMode === 'all' && initJson
  const status =
    publishNote || (evalMode === 'all' && !initJson)
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
        `kb ${graphCmd(base, graphWithBase)}`,
        `kb ${logsCmd(evalMode)}`,
        `kb query "<8 questions>" --base ${base} --output json`,
        publishDir ? `kb publish jekyll --base ${base} --dir ${publishDir}/ --apply` : null, // all mode only
      ].filter(Boolean),
      workdir,
      run_dir: runDir,
      publish_dir: publishDir || null,
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
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exit(1)
})
