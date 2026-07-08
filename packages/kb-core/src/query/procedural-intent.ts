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
 */

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
  /\bhow (?:is|does) .* (?:configured|initialized|bootstrapped|wired)\b/,
  /\b(?:install|build|compile|configure|deploy|provision) (?:and|&) /,
]

/** True when the question reads as a how-to / procedural request. */
export function isProceduralQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  if (!q) return false
  return PROCEDURAL_PATTERNS.some(re => re.test(q))
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
].join('\n')
