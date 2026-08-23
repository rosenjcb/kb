/**
 * Recognize questions that ask whether X affects Y, and make sure Y's own code was actually read.
 *
 * Retrieval only ever returns evidence that something *exists*. It has no way to establish an
 * absence. So for a question like "could the import path leave the Save button disabled?", the
 * pipeline happily retrieves the import path, finds no call into the Save logic, and concludes the
 * Save button is fine — without ever having looked at the Save button's own code. The reasoning is
 * "I didn't see it" presented as "it doesn't happen", and it is indistinguishable from a real
 * answer.
 *
 * The fix is not smarter synthesis, it is a retrieval obligation: if the question makes a claim
 * about Y, Y's own definition has to be in the evidence, or the answer has to admit it isn't.
 */

import { isEnvFalse } from '../config/env-boolean.js'

export interface CausalTarget {
  /** The thing being asked about — the side whose own code must be inspected. */
  target: string
}

/**
 * On by default; `KB_QUERY_NEGATIVE_CLAIM_GUARD=false` disables it so an A/B can measure off-vs-on.
 * Temporary scaffolding — the whole switch is removed once the gain is confirmed.
 */
export function isNegativeClaimGuardEnabled(): boolean {
  return !isEnvFalse(process.env.KB_QUERY_NEGATIVE_CLAIM_GUARD)
}

const CAUSAL_VERBS =
  'affect|affects|change|changes|break|breaks|cause|causes|prevent|prevents|impact|impacts|reset|resets|clear|clears|disable|disables|invalidate|invalidates|corrupt|corrupts|leave|leaves'

/**
 * Ordered patterns. Each captures the *target* — the side the question makes a claim about, which
 * is the side retrieval tends not to visit.
 */
const CAUSAL_PATTERNS: RegExp[] = [
  // "does/can/could/will X <verb> Y"
  new RegExp(`\\b(?:does|do|can|could|will|would|might)\\b.*?\\b(?:${CAUSAL_VERBS})\\b\\s+(.+)`, 'i'),
  // "is/are Y affected by X"
  /\b(?:is|are|was|were)\s+(.+?)\s+affected\s+by\b/i,
  // "without breaking Y" / "does this break Y"
  /\bwithout\s+(?:breaking|affecting|invalidating|resetting)\s+(.+)/i,
]

/** Words that end the target phrase — everything after them is a new clause, not the target. */
const TARGET_STOP = /\s+\b(?:when|if|because|since|so that|which|that|after|before|while|and then)\b/i

function cleanTarget(raw: string): string {
  let t = raw.trim()
  const stop = TARGET_STOP.exec(t)
  if (stop?.index !== undefined) t = t.slice(0, stop.index)
  t = t
    .replace(/[?.!,;:]+\s*$/, '')
    .replace(/^\s*(?:the|a|an|any|its|their)\s+/i, '')
    .trim()
  // Keep it short enough to be a usable retrieval probe rather than a restated sentence.
  const words = t.split(/\s+/).filter(Boolean)
  return words.slice(0, 8).join(' ')
}

/**
 * The target of a causal/negative claim, or null when the question is not of that shape.
 *
 * Returns null generously: a false positive costs a wasted retrieval probe on every matching
 * query, so the patterns stay narrow rather than trying to catch every phrasing.
 */
export function detectCausalTarget(question: string): CausalTarget | null {
  const q = question.trim()
  if (!q) return null
  for (const re of CAUSAL_PATTERNS) {
    const m = re.exec(q)
    if (!m?.[1]) continue
    const target = cleanTarget(m[1])
    if (target.split(/\s+/).length < 2 && target.length < 4) continue
    if (!target) continue
    return { target }
  }
  return null
}

/** Retrieval probe for the target's own implementation, used to seed a required gap re-query. */
export function causalTargetProbe(target: CausalTarget): string {
  return `${target.target} definition implementation state handling`
}

/**
 * Synthesis-prompt fragment appended when a causal target was detected but its own code never
 * made it into the evidence.
 */
export const NEGATIVE_CLAIM_SYNTHESIS_GUIDANCE = [
  'This question asks whether one thing affects another. Evidence can show that something happens; it cannot, by absence, show that something does not happen.',
  'You may only make a claim about the affected thing if its own definition or state-handling code is present in the evidence. Not finding a reference to it elsewhere is not evidence that it is unaffected.',
  'If its own code is not in the evidence, say so explicitly — name what was not inspected and stop there — rather than inferring its behavior from the other side of the question.',
].join('\n')
