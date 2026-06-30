/**
 * Shared LLM auto-scoring for kb evaluation harnesses.
 *
 * Extracted from eval-run.mjs so both the KB harvest runner (eval-run.mjs) and the
 * control phase (control-core.mjs) score answers with the *same* rubric and the *same*
 * judge. Keeping one copy is what makes control-vs-KB a fair comparison.
 *
 * Public API:
 *   - RUBRIC_AXES                 // label-based axis definitions (single source of truth)
 *   - buildRubric(phrase, hasReferenceAnswers)
 *   - parseJsonObjectFromLLM(text)
 *   - scoreFromLabel(axisKey, value)   // label string -> ordinal 0-4 (numeric fallback)
 *   - clampScore0to4(x)
 *   - readQueryResultFile(file)   // handles control JSON + kb-query text
 *   - runAutoScoreFile({ workdir, questions, answers, outScoresPath, rubricPhrase, scoreRuns })
 *
 * Scoring is label-based: the judge picks a named label per axis (not a bare
 * number), which removes the "guess a number 0-4" failure mode. Each label maps
 * to an ordinal 0-4 level under the hood, so every downstream metric (adequacy
 * utility φ with τ=3, pass-rate ≥3 gates, success_score, the paper's equations)
 * is unchanged and historical artifacts stay comparable.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseQueryText } from './eval-shared.mjs'

// ---------------------------------------------------------------------------
// Result file reading (control JSON sentinel OR kb-query text)
// ---------------------------------------------------------------------------

/**
 * Read a per-question result file written by either runner.
 *
 * Control runs write JSON with a `__control__: true` sentinel already in the
 * parsed shape ({ answer, result_count, provenance, retrieval, telemetry }).
 * KB runs write raw `kb query` CLI text that must go through parseQueryText.
 *
 * @returns {{ answer: string|null, result_count: number, provenance: string[], retrieval: object, telemetry?: object }}
 */
export function readQueryResultFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(raw)
      if (obj && obj.__control__ === true) {
        return {
          answer: typeof obj.answer === 'string' ? obj.answer : null,
          result_count: Number(obj.result_count ?? 0),
          provenance: Array.isArray(obj.provenance) ? obj.provenance : [],
          retrieval: obj.retrieval ?? { method: null, detail: null, confidence: null },
          telemetry: obj.telemetry ?? null,
        }
      }
    } catch {
      /* fall through to text parsing */
    }
  }
  return parseQueryText(raw)
}

// ---------------------------------------------------------------------------
// Rubric: label-based axes (identical wording for control + KB)
//
// Why labels, not bare numbers: asking an LLM judge for "an integer 0–4" makes
// it guess a point on an unanchored scale. Naming each level forces it to pick
// the *described category* that fits the answer — a classification, not a
// magnitude estimate. Each label still carries an ordinal `score` (0–4) so all
// downstream math (φ adequacy utility, τ=3 pass gates, success_score) and the
// research paper's equations are unchanged. Deterministic axes (tokens, latency)
// stay numeric — they are measured, not judged.
//
// `RUBRIC_AXES` is the single source of truth: the judge prompt, the JSON schema
// hint, and the label→score maps are all derived from it.
// ---------------------------------------------------------------------------

/**
 * Ordered worst→best is avoided on purpose: labels are listed best→worst (score
 * 4→0) to match the prose the judges have always seen. `score` is the ordinal
 * level the label maps to.
 * @type {{ key: string, title: string, prompt: string, labels: { label: string, score: number, desc: string }[] }[]}
 */
export const RUBRIC_AXES = [
  {
    key: 'correctness',
    title: 'Correctness',
    prompt: 'Is the answer factually right and grounded in the supplied answer/evidence?',
    labels: [
      { label: 'correct', score: 4, desc: 'factually correct and grounded in the supplied answer/evidence' },
      { label: 'mostly_correct', score: 3, desc: 'mostly correct; only minor omissions' },
      { label: 'mixed', score: 2, desc: 'mixed; meaningful inaccuracies or unsupported inference' },
      { label: 'mostly_wrong', score: 1, desc: 'mostly wrong or misleading' },
      { label: 'no_answer', score: 0, desc: 'no useful answer' },
    ],
  },
  {
    key: 'usefulness',
    title: 'Usefulness',
    prompt: 'Does the answer help a developer act or understand the system?',
    labels: [
      { label: 'actionable', score: 4, desc: 'directly helps a developer act or understand the system' },
      { label: 'helpful', score: 3, desc: 'helpful but incomplete' },
      { label: 'needs_followup', score: 2, desc: 'some signal, but requires substantial follow-up' },
      { label: 'barely_helpful', score: 1, desc: 'barely helpful' },
      { label: 'not_helpful', score: 0, desc: 'not helpful' },
    ],
  },
  {
    key: 'relevance',
    title: 'Relevance',
    prompt:
      'Does the answer stay on the question, free of unrelated facts or padding? Judge focus, not correctness — a true but unrelated fact LOWERS this score.',
    labels: [
      { label: 'focused', score: 4, desc: 'every claim bears on the question; nothing extraneous' },
      { label: 'on_topic', score: 3, desc: 'mostly on-topic; minor tangents' },
      { label: 'padded', score: 2, desc: 'noticeable unrelated material diluting the answer' },
      { label: 'off_topic', score: 1, desc: 'dominated by off-topic facts' },
      { label: 'unrelated', score: 0, desc: 'answer is essentially about something else' },
    ],
  },
  {
    key: 'specificity',
    title: 'Specificity',
    prompt: 'Does the answer use concrete project-specific detail rather than generic filler?',
    labels: [
      { label: 'concrete', score: 4, desc: 'concrete project-specific APIs, paths, build flags, or mechanisms' },
      { label: 'some_detail', score: 3, desc: 'some concrete detail' },
      { label: 'partly_generic', score: 2, desc: 'partly generic' },
      { label: 'mostly_generic', score: 1, desc: 'mostly generic' },
      { label: 'generic', score: 0, desc: 'purely generic or evasive' },
    ],
  },
  {
    key: 'evidence_handling',
    title: 'Evidence handling',
    prompt: 'Is the answer constrained to evidence and honest about gaps?',
    labels: [
      { label: 'well_grounded', score: 4, desc: 'clearly tied to evidence; acknowledges gaps' },
      { label: 'grounded', score: 3, desc: 'reasonably grounded' },
      { label: 'some_speculation', score: 2, desc: 'some speculation' },
      { label: 'speculative', score: 1, desc: 'strong speculation or unsupported claims' },
      { label: 'ungrounded', score: 0, desc: 'no evidence discipline' },
    ],
  },
]

/** axisKey -> { normalizedLabel: score } */
const LABEL_TO_SCORE = Object.fromEntries(
  RUBRIC_AXES.map(axis => [
    axis.key,
    Object.fromEntries(axis.labels.map(l => [l.label, l.score])),
  ])
)

/** axisKey -> ["label (4)", "label (3)", …] for the schema hint. */
function allowedLabelList(axisKey) {
  const axis = RUBRIC_AXES.find(a => a.key === axisKey)
  return axis ? axis.labels.map(l => l.label) : []
}

export function clampScore0to4(x) {
  const n = Math.round(Number(x))
  if (!Number.isFinite(n)) return 0
  return Math.min(4, Math.max(0, n))
}

/**
 * Resolve a judge's per-axis verdict to an ordinal score 0–4.
 *
 * Accepts the new label strings ("mostly_correct"), tolerates spacing/casing/
 * hyphen variants, and degrades gracefully to the legacy numeric path so a judge
 * (or an old artifact) that still emits a bare 0–4 keeps working.
 *
 * @param {string} axisKey one of RUBRIC_AXES[].key
 * @param {string|number|null|undefined} value
 * @returns {number} integer 0–4 (0 when unrecognized)
 */
export function scoreFromLabel(axisKey, value) {
  if (typeof value === 'number') return clampScore0to4(value)
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    const map = LABEL_TO_SCORE[axisKey]
    if (map && Object.hasOwn(map, norm)) return map[norm]
    const n = Number(value)
    if (Number.isFinite(n)) return clampScore0to4(n)
  }
  return 0
}

export function buildRubric(phrase, hasReferenceAnswers = false) {
  const referenceNote = hasReferenceAnswers
    ? '\n\nA reference answer is provided for each question. Use it as a factual ground-truth to assess correctness — if the actual answer contradicts or omits key facts present in the reference, pick a lower Correctness label accordingly. The reference answer is not a style template; answers that cover the same facts differently are still correct.'
    : ''
  const axisLines = RUBRIC_AXES.map(axis => {
    const choices = axis.labels.map(l => `"${l.label}" — ${l.desc}`).join('; ')
    return `${axis.title} — ${axis.prompt}\n  Pick exactly one label: ${choices}.`
  }).join('\n')
  return `You score answers for ${phrase}. For each axis below, choose the single descriptive LABEL that best fits the answer. Do not output a number — output the label string, copied exactly. The labels are ordered best to worst.

${axisLines}

Penalize boilerplate-only answers, stub lines that are not real explanations, and answers that miss the core of the question even if retrieval metadata looks confident.${referenceNote}`
}

// ---------------------------------------------------------------------------
// JSON extraction from a (possibly fenced / chatty) LLM response
// ---------------------------------------------------------------------------

export function parseJsonObjectFromLLM(text) {
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

function clipText(s, maxLen) {
  if (typeof s !== 'string' || !s) return ''
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}\n…[truncated]`
}

// ---------------------------------------------------------------------------
// Judge calls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Retry helper for transient network errors
// ---------------------------------------------------------------------------

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1500 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i
        console.error(`[eval] judge call failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${e.message}`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}

export async function callGeminiJudgeJson({ apiKey, model, systemInstruction, userText }) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  return withRetry(async () => {
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
  })
}

export async function callOpenAIJudgeJson({ apiKey, model, systemInstruction, userText }) {
  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText },
    ],
  }
  return withRetry(async () => {
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
  })
}

// ---------------------------------------------------------------------------
// Auto-score a workdir of q1.json…qN.json (control or KB)
// ---------------------------------------------------------------------------

/**
 * Score `count` question/answer pairs from `workdir/q{n}.json`.
 * Works identically for control runs and KB runs because it reads via
 * readQueryResultFile() and uses the shared rubric.
 *
 * @returns {{ normalized: object[], providerUsed: string, modelUsed: string, outScoresPath: string }}
 */
export async function runAutoScoreFile({
  workdir,
  questions,
  answers,
  outScoresPath,
  rubricPhrase,
  scoreRuns = 1,
}) {
  const count = questions.length
  const hasRef = Array.isArray(answers) && answers.length === count
  const RUBRIC = buildRubric(rubricPhrase, hasRef)
  const blocks = questions.map((q, i) => {
    const parsed = readQueryResultFile(path.join(workdir, `q${i + 1}.json`))
    const ans = parsed.answer || ''
    const prov = parsed.provenance
    const ret = parsed.retrieval
    const refSection = hasRef ? `\nReference answer:\n${clipText(answers[i], 3000)}\n` : ''
    return `### Question ${i + 1}\n${q}\n\nRetrieval (summary): ${clipText(JSON.stringify(ret), 2000)}\nProvenance ids: ${JSON.stringify(prov)}\n${refSection}\nAnswer:\n${clipText(ans, 6000)}\n`
  })

  const axisSchemaLines = RUBRIC_AXES.map(
    axis => `  - "${axis.key}": one of ${JSON.stringify(allowedLabelList(axis.key))}`
  ).join('\n')
  const schemaHint = `Return a single JSON object with exactly one key "scores" whose value is an array of exactly ${count} objects in question order (index 0 = question 1). Each object must have these keys, each set to one of the allowed LABEL strings (not a number):\n${axisSchemaLines}\n  - "notes": short string rationale\nUse the exact label strings shown above. No markdown fences.`

  const systemInstruction = `${RUBRIC}\n\n${schemaHint}`
  const userText = `Score these ${count} question/answer pairs.\n\n${blocks.join('\n---\n')}`

  const geminiKey = process.env.GEMINI_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  let providerUsed
  let modelUsed

  if (geminiKey) {
    providerUsed = 'gemini'
    modelUsed = process.env.EVAL_SCORER_MODEL || 'gemini-2.5-flash'
  } else if (openaiKey) {
    providerUsed = 'openai'
    modelUsed = process.env.EVAL_SCORER_OPENAI_MODEL || 'gpt-4o-mini'
  } else {
    throw new Error(
      '[eval] --auto-score requires GEMINI_API_KEY or OPENAI_API_KEY (same keys as kb init).'
    )
  }

  /** Call the LLM once and return a normalized score array of length `count`. */
  async function callOnce() {
    const rawJsonText = geminiKey
      ? await callGeminiJudgeJson({
          apiKey: geminiKey,
          model: modelUsed,
          systemInstruction,
          userText,
        })
      : await callOpenAIJudgeJson({
          apiKey: openaiKey,
          model: modelUsed,
          systemInstruction,
          userText,
        })

    let obj = parseJsonObjectFromLLM(rawJsonText)
    if (Array.isArray(obj)) obj = { scores: obj }
    const scores = obj.scores
    if (!Array.isArray(scores) || scores.length !== count) {
      throw new Error(
        `[eval] Auto-score: expected { "scores": [ ... ${count} items ] }, got keys=${Object.keys(obj).join(',')}`
      )
    }
    return scores.map((row, idx) => {
      const usefulness = scoreFromLabel('usefulness', row.usefulness)
      return {
        correctness: scoreFromLabel('correctness', row.correctness),
        usefulness,
        // Fall back to usefulness when a judge omits relevance, so old/partial responses
        // degrade gracefully instead of scoring a hard 0 on the new axis.
        relevance: row.relevance != null ? scoreFromLabel('relevance', row.relevance) : usefulness,
        specificity: scoreFromLabel('specificity', row.specificity),
        evidence_handling: scoreFromLabel('evidence_handling', row.evidence_handling),
        notes:
          typeof row.notes === 'string' && row.notes.trim()
            ? row.notes.trim()
            : `Auto-score question ${idx + 1} (${providerUsed})`,
      }
    })
  }

  const runs = Math.max(1, scoreRuns)
  const allRuns = []
  for (let r = 0; r < runs; r++) {
    if (runs > 1) console.error(`[eval] auto-score run ${r + 1}/${runs}`)
    allRuns.push(await callOnce())
  }

  // Average numeric axes across runs; keep notes from the last run
  const normalized = questions.map((_, idx) => {
    const axes = ['correctness', 'usefulness', 'relevance', 'specificity', 'evidence_handling']
    const averaged = {}
    for (const axis of axes) {
      const m = allRuns.reduce((s, run) => s + run[idx][axis], 0) / runs
      averaged[axis] = Math.round(m * 10) / 10
    }
    averaged.notes = allRuns[allRuns.length - 1][idx].notes
    if (runs > 1) averaged.notes = `[avg×${runs}] ${averaged.notes}`
    return averaged
  })

  fs.mkdirSync(path.dirname(path.resolve(outScoresPath)), { recursive: true })
  fs.writeFileSync(path.resolve(outScoresPath), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  console.error(
    `[eval] auto-score wrote ${path.resolve(outScoresPath)} (${providerUsed}/${modelUsed}${runs > 1 ? ` ×${runs}` : ''})`
  )

  return { normalized, providerUsed, modelUsed, outScoresPath: path.resolve(outScoresPath) }
}
