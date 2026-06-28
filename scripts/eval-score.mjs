/**
 * Shared LLM auto-scoring for kb evaluation harnesses.
 *
 * Extracted from eval-run.mjs so both the KB harvest runner (eval-run.mjs) and the
 * control phase (control-core.mjs) score answers with the *same* rubric and the *same*
 * judge. Keeping one copy is what makes control-vs-KB a fair comparison.
 *
 * Public API:
 *   - buildRubric(phrase, hasReferenceAnswers)
 *   - parseJsonObjectFromLLM(text)
 *   - clampScore0to4(x)
 *   - readQueryResultFile(file)   // handles control JSON + kb-query text
 *   - runAutoScoreFile({ workdir, questions, answers, outScoresPath, rubricPhrase, scoreRuns })
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
// Rubric (identical wording for control + KB)
// ---------------------------------------------------------------------------

export function clampScore0to4(x) {
  const n = Math.round(Number(x))
  if (!Number.isFinite(n)) return 0
  return Math.min(4, Math.max(0, n))
}

export function buildRubric(phrase, hasReferenceAnswers = false) {
  const referenceNote = hasReferenceAnswers
    ? '\n\nA reference answer is provided for each question. Use it as a factual ground-truth to assess correctness — if the actual answer contradicts or omits key facts present in the reference, lower the Correctness score accordingly. The reference answer is not a style template; answers that cover the same facts differently are still correct.'
    : ''
  return `You score answers for ${phrase}. Each axis must be an integer 0–4.

Correctness — 4: factually correct and grounded in the supplied answer/evidence; 3: mostly correct; 2: mixed or meaningful inaccuracies; 1: mostly wrong; 0: no useful answer.
Usefulness — 4: directly helps a developer act or understand the system; 3: helpful but incomplete; 2: some signal, needs substantial follow-up; 1: barely helpful; 0: not helpful.
Relevance — does the answer stay on the question, free of unrelated facts or padding? 4: every claim bears on the question, nothing extraneous; 3: mostly on-topic, minor tangents; 2: noticeable unrelated material diluting the answer; 1: dominated by off-topic facts; 0: answer is essentially about something else. Judge focus, not correctness — a true but unrelated fact LOWERS this score.
Specificity — 4: concrete project-specific APIs, paths, build flags, or mechanisms; 3: some concrete detail; 2: partly generic; 1: mostly generic; 0: purely generic or evasive.
Evidence handling — 4: clearly tied to evidence, acknowledges gaps; 3: reasonably grounded; 2: some speculation; 1: strong speculation or unsupported claims; 0: no evidence discipline.

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

  const schemaHint = `Return a single JSON object with exactly one key "scores" whose value is an array of exactly ${count} objects in question order (index 0 = question 1). Each object must have: "correctness", "usefulness", "relevance", "specificity", "evidence_handling" (integers 0-4) and "notes" (short string rationale). No markdown fences.`

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
    return scores.map((row, idx) => ({
      correctness: clampScore0to4(row.correctness),
      usefulness: clampScore0to4(row.usefulness),
      // Fall back to usefulness when a judge omits relevance, so old/partial responses
      // degrade gracefully instead of scoring a hard 0 on the new axis.
      relevance: clampScore0to4(row.relevance ?? row.usefulness),
      specificity: clampScore0to4(row.specificity),
      evidence_handling: clampScore0to4(row.evidence_handling),
      notes:
        typeof row.notes === 'string' && row.notes.trim()
          ? row.notes.trim()
          : `Auto-score question ${idx + 1} (${providerUsed})`,
    }))
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
