import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
  DEFAULT_JUDGE_THINKING_BUDGET,
  RUBRIC_AXES,
  SCORE_BATCH_SIZE,
  buildRubric,
  callGeminiJudgeJson,
  parseJsonObjectFromLLM,
  runAutoScoreFile,
  scoreFromLabel,
  withRetry,
} from '../../scripts/eval-score.mjs'

describe('withRetry', () => {
  it('[TC-35] returns the result immediately when the fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('[TC-36] retries and succeeds on a later attempt', async () => {
    let calls = 0
    const fn = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'recovered'
    })
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 0 })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('[TC-37] throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'))
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('fetch failed')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('[TC-38] does not retry on success even with attempts > 1', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    await withRetry(fn, { attempts: 5, baseDelayMs: 0 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('label-based scoring', () => {
  it('[TC-39] every rubric axis defines five labels mapping onto ordinal levels 0–4', () => {
    expect(RUBRIC_AXES).toHaveLength(5)
    for (const axis of RUBRIC_AXES) {
      const scores = axis.labels.map(l => l.score).sort((a, b) => a - b)
      expect(scores).toEqual([0, 1, 2, 3, 4])
      // labels are distinct strings
      expect(new Set(axis.labels.map(l => l.label)).size).toBe(5)
    }
  })

  it('[TC-40] scoreFromLabel resolves a known label to its ordinal level', () => {
    expect(scoreFromLabel('correctness', 'correct')).toBe(4)
    expect(scoreFromLabel('correctness', 'mostly_correct')).toBe(3)
    expect(scoreFromLabel('relevance', 'unrelated')).toBe(0)
    expect(scoreFromLabel('evidence_handling', 'well_grounded')).toBe(4)
  })

  it('[TC-41] scoreFromLabel tolerates casing, spaces, and hyphens', () => {
    expect(scoreFromLabel('usefulness', 'Needs-Followup')).toBe(2)
    expect(scoreFromLabel('relevance', 'On Topic')).toBe(3)
  })

  it('[TC-42] scoreFromLabel falls back to the legacy numeric path', () => {
    expect(scoreFromLabel('correctness', 3)).toBe(3)
    expect(scoreFromLabel('correctness', '4')).toBe(4)
    expect(scoreFromLabel('correctness', 9)).toBe(4) // clamped
  })

  it('[TC-43] scoreFromLabel returns 0 for an unrecognized verdict', () => {
    expect(scoreFromLabel('correctness', 'banana')).toBe(0)
    expect(scoreFromLabel('correctness', null)).toBe(0)
    expect(scoreFromLabel('correctness', undefined)).toBe(0)
  })

  it('[TC-44] the rubric instructs the judge to pick labels, not numbers', () => {
    const rubric = buildRubric('the kb self-check', false)
    expect(rubric).toContain('output the label string')
    expect(rubric).toContain('"mostly_correct"')
    expect(rubric).not.toContain('integer 0')
  })
})

describe('parseJsonObjectFromLLM', () => {
  it('[TC-45] parses a top-level JSON array', () => {
    const arr = [{ correctness: 'correct' }]
    expect(parseJsonObjectFromLLM(JSON.stringify(arr))).toEqual(arr)
  })
})

describe('callGeminiJudgeJson thinking budget', () => {
  it('[TC-47] caps gemini-3 thinking and maxOutputTokens instead of unbounded reasoning', async () => {
    const prevBudget = process.env.EVAL_SCORER_THINKING_BUDGET
    delete process.env.EVAL_SCORER_THINKING_BUDGET
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"scores":[]}' }] } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await callGeminiJudgeJson({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
        systemInstruction: 'score',
        userText: 'Score these 1 questions',
      })
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(DEFAULT_JUDGE_THINKING_BUDGET)
      expect(body.generationConfig.maxOutputTokens).toBe(DEFAULT_JUDGE_MAX_OUTPUT_TOKENS)
      expect(DEFAULT_JUDGE_THINKING_BUDGET).toBe(1024)
      expect(DEFAULT_JUDGE_MAX_OUTPUT_TOKENS).toBeLessThan(65536)
    } finally {
      vi.unstubAllGlobals()
      if (prevBudget === undefined) delete process.env.EVAL_SCORER_THINKING_BUDGET
      else process.env.EVAL_SCORER_THINKING_BUDGET = prevBudget
    }
  })

  it('[TC-48] honors EVAL_SCORER_THINKING_BUDGET=0 to disable judge thinking', async () => {
    const prevBudget = process.env.EVAL_SCORER_THINKING_BUDGET
    process.env.EVAL_SCORER_THINKING_BUDGET = '0'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"scores":[]}' }] } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await callGeminiJudgeJson({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
        systemInstruction: 'score',
        userText: 'Score these 1 questions',
      })
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      if (prevBudget === undefined) delete process.env.EVAL_SCORER_THINKING_BUDGET
      else process.env.EVAL_SCORER_THINKING_BUDGET = prevBudget
    }
  })
})

describe('runAutoScoreFile batching', () => {
  it('[TC-46] scores many questions in multiple judge batches', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-score-'))
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(workdir, `q${i + 1}.json`),
        JSON.stringify({
          __control__: true,
          answer: `answer ${i + 1}`,
          result_count: 0,
          provenance: [],
          retrieval: { method: 'control-agent', detail: null, confidence: null },
        })
      )
    }

    const judgeCalls = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const userText = body.contents?.[0]?.parts?.[0]?.text ?? ''
      const m = /Score these (\d+) question/.exec(userText)
      const batchCount = Number(m?.[1] ?? 0)
      expect(batchCount).toBeLessThanOrEqual(SCORE_BATCH_SIZE)
      const scores = Array.from({ length: batchCount }, () => ({
        correctness: 'correct',
        usefulness: 'actionable',
        relevance: 'focused',
        specificity: 'concrete',
        evidence_handling: 'well_grounded',
        notes: 'ok',
      }))
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }],
        }),
      }
    })

    const prev = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-key'
    vi.stubGlobal('fetch', judgeCalls)
    try {
      const questions = Array.from({ length: 12 }, (_, i) => `question ${i + 1}?`)
      const { normalized } = await runAutoScoreFile({
        workdir,
        questions,
        outScoresPath: path.join(workdir, 'auto-scores.json'),
        rubricPhrase: 'kb self-check',
        scoreRuns: 1,
      })
      expect(normalized).toHaveLength(12)
      expect(judgeCalls).toHaveBeenCalledTimes(Math.ceil(12 / SCORE_BATCH_SIZE))
    } finally {
      vi.unstubAllGlobals()
      if (prev === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = prev
    }
  })
})
