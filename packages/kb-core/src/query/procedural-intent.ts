/**
 * Query-side procedural-answer support — no index changes.
 *
 * Detects "how do I / step-by-step" questions and supplies a synthesis-prompt
 * fragment that tells the model to reconstruct an **ordered** sequence from the
 * retrieved evidence, cite the backing symbol per step, and flag gaps instead of
 * fabricating order.
 *
 * This is the query-only slice of the Flow Facts plan: order is *inferred* from
 * the facts already retrieved, not walked over dedicated `precedes` edges. It is
 * deliberately conservative — it changes how the answer is shaped, never what is
 * retrieved — so it is safe to ship ahead of any index-side work.
 *
 * Kill-switch: set `KB_PROCEDURAL_SYNTHESIS=false` to disable detection entirely
 * (answers fall back to the default synthesis shape). Used for A/B measurement
 * and as a production safety valve.
 */

import { isEnvFalse } from '../config/env-boolean.js'

/**
 * Phrasings that signal the reader wants a procedure (an ordered sequence of
 * actions) rather than a topic summary. Kept broad on purpose: a false positive
 * only nudges the model toward numbered, ordered output, which is cheap; a false
 * negative leaves the answer unshaped.
 */
const PROCEDURAL_PATTERNS: RegExp[] = [
  /\bhow (?:do|would|can|should|might) (?:i|we|you|one)\b/,
  /\bhow to\b/,
  /\bstep[-\s]?by[-\s]?step\b/,
  /\bwhat (?:are|were) the (?:steps|stages|phases)\b/,
  /\bsteps (?:to|for|involved|needed|required|are)\b/,
  /\bwalk (?:me )?through\b/,
  /\bset[-\s]?up\b/,
  /\bset up\b/,
  /\bget(?:ting)? started\b/,
  /\bprocess (?:for|of|to)\b/,
  /\bprocedure\b/,
  /\bworkflow\b/,
  /\bin what order\b/,
  /\bwhat order\b/,
  // Sequence framing: "in order" (but not the purpose phrase "in order to"),
  // "order in which", "sequence of", and "trace … <flow/loop/order/…>".
  /\bin order\b(?!\s+to\b)/,
  /\border (?:in which|of operations)\b/,
  /\bsequence of\b/,
  /\btrace\b[^.?!]*\b(?:sequence|order|flow|lifecycle|pipeline|path|loop)\b/,
  /\bhow (?:is|does) .* (?:configured|initialized|bootstrapped|wired)\b/,
  /\b(?:install|build|compile|configure|deploy|provision) (?:and|&) /,
]

/**
 * Unambiguous procedural triggers. These carry a how-to / sequence intent strong
 * enough to fire even when the question also opens with a definitional wh-word.
 */
const STRONG_PROCEDURAL: RegExp[] = [
  /\bhow (?:do|would|can|should|might) (?:i|we|you|one)\b/,
  /\bhow to\b/,
  /\bstep[-\s]?by[-\s]?step\b/,
  /\bsteps (?:to|for|involved|needed|required)\b/,
  /\bwhat (?:are|were) the (?:steps|stages|phases)\b/,
  /\bwalk (?:me )?through\b/,
  /\bin what order\b/,
  /\bget(?:ting)? started\b/,
  // Sequence framing is a strong cue — "What happens …, in order?" wants a sequence,
  // not a definition, so it overrides the definitional-lead guard.
  /\bin order\b(?!\s+to\b)/,
  /\border (?:in which|of operations)\b/,
  /\bsequence of\b/,
  /\btrace\b[^.?!]*\b(?:sequence|order|flow|lifecycle|pipeline|path|loop)\b/,
]

/**
 * A question that opens with a definitional wh-word ("What problem does…",
 * "Which files…") asks to explain a thing, not to perform a procedure — even if
 * it later mentions a "workflow" or "setup". Firing procedural formatting on
 * those over-constrains an explanatory answer (observed on the kb eval: a "What
 * problem does kb solve, and the workflow…" question lost usefulness/specificity
 * when forced into numbered steps).
 */
const DEFINITIONAL_LEAD = /^\s*(?:what|which|who|whose|why|when)\b/

/** True when the question reads as a how-to / procedural request. */
export function isProceduralQuestion(question: string): boolean {
  if (isEnvFalse(process.env.KB_PROCEDURAL_SYNTHESIS)) return false
  const q = question.toLowerCase().trim()
  if (!q) return false
  if (!PROCEDURAL_PATTERNS.some(re => re.test(q))) return false
  // Definitional lead without a strong how-to/sequence cue → explain, don't sequence.
  if (DEFINITIONAL_LEAD.test(q) && !STRONG_PROCEDURAL.some(re => re.test(q))) return false
  return true
}

/**
 * Synthesis-prompt fragment appended when {@link isProceduralQuestion} matches.
 * Instructs the model to impose order on the evidence and to be honest about
 * where the evidence does not establish that order.
 */
export const PROCEDURAL_SYNTHESIS_GUIDANCE = [
  'This is a procedural / how-to question: the reader wants an ordered sequence of steps, not a topic summary.',
  'Reconstruct the order from the evidence — follow call order, data dependencies (produce → consume), and prerequisite/setup relationships to sequence the steps.',
  'Present the answer as a numbered list of concrete steps in the order they must happen. Keep each step to a single action and name the backing file, function, command, or setting inline so the reader can verify it.',
  'When a prerequisite must hold before a step, fold it into that step. A one-line summary of the overall flow before the list is welcome only when it aids scanning.',
  'Where the evidence does not establish the order of a step, or a step appears to be missing, say so plainly (e.g. "order not established by the available evidence") instead of inventing a sequence. Do not fabricate steps to fill gaps.',
  'If the question asks for a procedure the system does not support (a capability it does not have, or a task outside what the evidence covers), lead with that boundary plainly and do not manufacture a step-by-step guide for the unsupported task — a correct refusal beats an invented procedure.',
].join('\n')
