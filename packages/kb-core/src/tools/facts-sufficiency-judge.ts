import { type LLMFailure, toLLMFailure } from '../core/llm-error.js'
import type { RunCollector } from '../core/telemetry'
import { estimateCost } from '../core/telemetry'
import type { LLMProvider } from '../core/types'

/** Minimum relevant facts (score >= 0.5) before calling the judge. */
const JUDGE_MIN_RELEVANT_FACTS = 5
/** Call the judge at most every N loop iterations. */
export const JUDGE_CALL_INTERVAL = 3
/** Facts sent to judge — top-ranked only to keep the call cheap. */
const JUDGE_MAX_FACTS = 40
const JUDGE_MAX_CHARS_PER_FACT = 220

export type SufficiencyVerdict = 'answerable' | 'insufficient'

export type FactsSufficiencyJudge = (
  query: string,
  relevantFacts: Array<{ id: string; text: string }>
) => Promise<SufficiencyVerdict>

/**
 * @param onFailure Invoked when the judge call fails on an LLM/transport error. The
 * verdict still falls back to `insufficient` (the safe choice — keep researching), but
 * the caller can record the degradation so a provider outage is distinguishable from a
 * genuine "not answerable yet" verdict. Without this the two are identical, and an
 * outage silently burns the full iteration budget on every query.
 */
export function makeSufficiencyJudge(
  llm: LLMProvider,
  collector?: RunCollector,
  onFailure?: (failure: LLMFailure) => void
): FactsSufficiencyJudge {
  return async (query, relevantFacts) => {
    if (relevantFacts.length < JUDGE_MIN_RELEVANT_FACTS) return 'insufficient'

    const sample = relevantFacts.slice(0, JUDGE_MAX_FACTS)
    const factLines = sample
      .map((f, i) => `${i + 1}. ${f.text.slice(0, JUDGE_MAX_CHARS_PER_FACT).replace(/\n/g, ' ')}`)
      .join('\n')

    const startMs = Date.now()
    const startedAt = new Date().toISOString()
    try {
      const response = await llm.call({
        messages: [
          {
            role: 'user',
            content: [
              `Query: ${query}`,
              '',
              'Do the facts below contain enough information to give a complete, accurate answer to the query?',
              'Reply with exactly one word: ANSWERABLE or INSUFFICIENT',
              '',
              factLines,
            ].join('\n'),
          },
        ],
        temperature: 0,
        maxTokens: 10,
      })

      if (collector) {
        collector.addStage({
          stage: 'facts-sufficiency-judge:check',
          startedAt,
          durationMs: Date.now() - startMs,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          estimatedCostUsd: estimateCost(
            llm.name,
            llm.model,
            response.usage.inputTokens,
            response.usage.outputTokens
          ),
          provider: llm.name,
          model: llm.model,
        })
      }

      return response.text.trim().toUpperCase().startsWith('ANSWERABLE')
        ? 'answerable'
        : 'insufficient'
    } catch (error) {
      onFailure?.(toLLMFailure('sufficiency-judge', error, llm.name))
      return 'insufficient'
    }
  }
}

export function shouldCallJudge(iter: number, relevantFactCount: number): boolean {
  return relevantFactCount >= JUDGE_MIN_RELEVANT_FACTS && iter % JUDGE_CALL_INTERVAL === 0
}
