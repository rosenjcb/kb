/**
 * Shared ≥3 quality pass gate for kb and control harvest scoring.
 *
 * Kept in its own module so eval-score.mjs (judge) and eval-shared.mjs
 * (aggregates) can import it without a circular dependency.
 */

export const QUALITY_PASS_AXES = ['correctness', 'usefulness', 'relevance', 'evidence_handling']
export const QUALITY_PASS_THRESHOLD = 3

/**
 * True when every quality axis is at the pass floor. Specificity is scored
 * but is not a gate — it is a style/detail signal, not honesty.
 *
 * @param {Record<string, number>|null|undefined} scores
 */
export function passesQualityGate(scores) {
  if (!scores || typeof scores !== 'object') return false
  return QUALITY_PASS_AXES.every(axis => (Number(scores[axis]) || 0) >= QUALITY_PASS_THRESHOLD)
}
