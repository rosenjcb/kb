/**
 * Prose-claim grounding (issue #223).
 *
 * The existing grounding checks — {@link findUngroundedFileReferences} plus the
 * evidence-label downgrade in `service/serialize.ts` — only verify that *file
 * names* cited in a synthesized answer actually appear in the retrieved sources.
 * They say nothing about whether the answer's *prose claims* are supported by
 * those sources. A confident, specific-sounding causal claim built from a real
 * but off-target source ("`FlowsApi` confirms flow import POSTs to the backend")
 * cites a grounded file and sails through every existing check while being wrong
 * for the actual code path.
 *
 * This module adds an optional second LLM pass — run only after synthesis, only
 * when opted in — that re-reads the answer against the same evidence and lists
 * claims the evidence does not directly support. The verdict is surfaced as a
 * caveat note and downgrades the evidence label, exactly as the file-name check
 * already does, so an unsupported prose claim can no longer coexist with a
 * `strong` label.
 *
 * ## Why it is opt-in, not on by default
 *
 * It is a whole extra LLM round-trip per query — added latency and tokens on
 * every answer — to catch a failure that only some answers exhibit. The decision
 * (recorded in `core/QUERY_INTERNALS.md`) is to ship it **opt-in only** until the
 * caught-hallucination rate vs. added-cost tradeoff is measured with
 * `kb:evaluation-run`. When enabled it targets only answers at or above a
 * confidence floor (default `strong`), because the confidently-wrong answer is
 * both the dangerous case from #223 and the one where a second opinion is worth
 * paying for — a `weak` answer already carries a verify note and a downgrade.
 */

import { type EvidenceLabel, isEvidenceAtLeast, parseEvidenceLabel } from '../core/evidence-label'
import { isEnvTrue } from '../config/env-boolean'
import {
  MAX_FACT_CONTENT_CHARS,
  type RetrievedFactForLLM,
  formatRetrievedFactsForLLM,
} from '../core/retrieval-context.js'
import type { LLMProvider } from '../core/types.js'

/** Output budget for the verify pass — it lists claims, it does not re-answer. */
const CLAIM_VERIFY_MAX_OUTPUT_TOKENS = 1024

/** Cap on how many unsupported claims to carry forward, so one long list can't flood the caller. */
const MAX_UNSUPPORTED_CLAIMS = 8

/**
 * Whether the claim-verification pass should run for this answer.
 *
 * Opt in with `KB_QUERY_VERIFY_CLAIMS=true` (env) or `verifyClaims: true` (the
 * per-call param). Default off. Even when opted in, the answer's evidence must be
 * at least `KB_QUERY_VERIFY_MIN_CONFIDENCE` (default `strong`) — verifying a
 * `weak` answer spends a round-trip to re-confirm a caveat it already carries.
 */
export function shouldVerifyClaims(input: {
  /** Explicit per-call opt-in; overrides the env default when set. */
  verifyClaims?: boolean
  /** The answer's current evidence label; undefined skips the floor check (still runs if opted in). */
  evidence?: EvidenceLabel
  /** Read the env default; injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = input.env ?? process.env
  const enabled = input.verifyClaims ?? isEnvTrue(env.KB_QUERY_VERIFY_CLAIMS)
  if (!enabled) return false
  if (input.evidence === undefined) return true
  const floor = parseEvidenceLabel(env.KB_QUERY_VERIFY_MIN_CONFIDENCE, 'strong')
  return isEvidenceAtLeast(input.evidence, floor)
}

const CLAIM_VERIFY_SYSTEM_PROMPT = [
  'You are a strict grounding checker. You are given a question, an answer written by',
  'another assistant, and the source snippets that answer was supposed to be built from.',
  'Your only job is to find claims in the answer that the sources do NOT directly support.',
  '',
  'A claim is UNSUPPORTED when the sources do not state it and it does not follow directly',
  'from what they state — including a claim that inverts, overstates, or misattributes what',
  'the sources actually say (e.g. the answer says an action calls a backend API when the',
  'cited source shows it only sets local state). General knowledge is not a source: if the',
  'snippets do not back the claim, it is unsupported even if it sounds plausible.',
  '',
  'Do NOT flag: correct restatements, reasonable summaries the snippets support, or hedged',
  'language that already admits uncertainty. Judge only against the snippets provided.',
  '',
  'Output ONLY unsupported claims, one per line, each starting with "- " and quoting or',
  'closely paraphrasing the offending sentence. If every claim in the answer is supported by',
  'the sources, output exactly the single word NONE and nothing else.',
].join('\n')

/**
 * Turn the verifier's free-text reply into a clean list of unsupported claims.
 *
 * Accepts the `- claim` line format the prompt asks for, tolerates numbered or
 * un-bulleted lines, and treats a lone `NONE` (in any case, with optional
 * punctuation) as "all supported" → empty list. Deduped and capped.
 */
export function parseUnsupportedClaims(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  // A reply that is just "NONE" (possibly punctuated) means everything checked out.
  if (/^none[.!]?$/i.test(trimmed)) return []

  const claims: string[] = []
  const seen = new Set<string>()
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine
      .trim()
      .replace(/^[-*•]\s+/, '') // bullet markers
      .replace(/^\d+[.)]\s+/, '') // numbered lists
      .trim()
    if (!line) continue
    if (/^none[.!]?$/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    claims.push(line)
    if (claims.length >= MAX_UNSUPPORTED_CLAIMS) break
  }
  return claims
}

export interface ClaimVerificationOutcome {
  /** Claims the verifier judged unsupported by the evidence. Empty when the answer checks out. */
  unsupportedClaims: string[]
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Second-opinion pass: ask the model which claims in `answer` the `results`
 * snippets do not support. Throws on provider failure — the caller decides
 * whether to record it as a degraded (best-effort) stage; a verify outage must
 * never block the answer that was already produced.
 */
export async function verifyAnswerClaims(input: {
  question: string
  answer: string
  results: RetrievedFactForLLM[]
  llmProvider: LLMProvider
}): Promise<ClaimVerificationOutcome> {
  const evidence = formatRetrievedFactsForLLM(input.results, {
    maxContentChars: MAX_FACT_CONTENT_CHARS,
  })

  const userContent = [
    `Question:\n${input.question}`,
    '',
    `Answer to check:\n${input.answer}`,
    '',
    `Source snippets the answer must be grounded in:\n${evidence}`,
    '',
    'List the unsupported claims now, or output NONE.',
  ].join('\n')

  const completion = await input.llmProvider.call({
    messages: [{ role: 'user', content: userContent }],
    systemPrompt: CLAIM_VERIFY_SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: CLAIM_VERIFY_MAX_OUTPUT_TOKENS,
  })

  return {
    unsupportedClaims: parseUnsupportedClaims(completion.text),
    usage: {
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    },
  }
}
