/**
 * Categorical assessment vocabulary.
 *
 * An *assessment* is a judgment the system makes about its own work — how much
 * evidence a retrieval pass gathered, whether a claim is substantial enough to
 * write. Those judgments used to be expressed as floats (`confidence: 0.72`),
 * which caused two specific problems:
 *
 *  1. **The number was never measured.** It came from a blend whose weights, and
 *     a ladder whose steps, were typed in by hand. Nobody can demonstrate that
 *     0.72 is wrong, so it never got corrected.
 *  2. **Every consumer invented its own cut-point.** The same float was read by
 *     chat (refuse below 0.45), the MCP serializer (warn below its own bar), the
 *     checkpoint orchestrator (0.55 / 0.45), and the rescan writer (0.6 / 0.65).
 *     Four modules, four opinions, no shared definition of "weak".
 *
 * The fix is not a better number. It is to decide the category **once**, at the
 * point where the underlying metrics are known, and have every consumer compare
 * labels. Boundaries still exist — you cannot categorize without drawing a line —
 * but there is exactly one line per concept, it is named, and it lives here.
 *
 * Genuine measurements (fact scores, cosine similarity, result counts) stay
 * numeric. They are observations, not judgments. This module is only for the
 * judgments derived from them.
 */

/**
 * How much usable evidence a retrieval pass actually gathered. Ordered weakest
 * to strongest; `none` means the pass found nothing to answer from.
 */
export const EVIDENCE_LABELS = ['none', 'weak', 'moderate', 'strong'] as const

export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number]

const EVIDENCE_RANK: Record<EvidenceLabel, number> = {
  none: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
}

export function isEvidenceLabel(value: unknown): value is EvidenceLabel {
  return typeof value === 'string' && (EVIDENCE_LABELS as readonly string[]).includes(value)
}

/** True when `label` is at least as strong as `floor`. The only comparison consumers need. */
export function isEvidenceAtLeast(label: EvidenceLabel, floor: EvidenceLabel): boolean {
  return EVIDENCE_RANK[label] >= EVIDENCE_RANK[floor]
}

/** Weakest of a set — used to summarize a run of checkpoints. */
export function weakestEvidence(labels: readonly EvidenceLabel[]): EvidenceLabel | undefined {
  let out: EvidenceLabel | undefined
  for (const label of labels) {
    if (!out || EVIDENCE_RANK[label] < EVIDENCE_RANK[out]) out = label
  }
  return out
}

/**
 * Parse a configured floor (env var / config value). Unknown or absent input
 * returns `fallback` — a misconfigured label must never silently disable a gate.
 */
export function parseEvidenceLabel(
  raw: string | undefined,
  fallback: EvidenceLabel
): EvidenceLabel {
  const normalized = raw?.trim().toLowerCase()
  return isEvidenceLabel(normalized) ? normalized : fallback
}

/**
 * The single place a retrieval pass's metrics become a category.
 *
 * `avgTop` is the mean score of the top-ranked facts and `conceptCoverage` the
 * share of query concepts touched — both measured, both real observations.
 *
 * The blend and the two cut-points below are inherited verbatim from the float
 * this function replaced, so the categorical form draws exactly the same line
 * the chat gate drew before: a turn is answered iff
 * `avgTop * 0.75 + conceptCoverage * 0.25 >= 0.45`, or `avgTop >= 0.65`.
 *
 * Deliberately not re-derived. An earlier draft of this function used tidier
 * boundaries (`avgTop >= 0.45 || conceptCoverage >= 0.6`) and, on a sweep of the
 * metric space, changed the answer/refuse verdict on **17% of it** — mostly
 * answering turns whose top facts scored near zero but which touched many
 * concepts. Representation changes must not move behavior; retuning these
 * numbers is a separate, measured decision (#207).
 */
export function assessRetrievalEvidence(metrics: {
  uniqueFacts: number
  avgTop: number
  conceptCoverage: number
}): EvidenceLabel {
  if (metrics.uniqueFacts <= 0) return 'none'
  const blended = metrics.avgTop * 0.75 + metrics.conceptCoverage * 0.25
  // 0.7 was the MCP verify-note cut-point, 0.45 the chat refusal floor. Both are
  // reproduced exactly, so the two live gates keep their existing boundaries.
  //
  // The old code also carried a `floorFromStrongSingleFact` term that lifted
  // confidence to 0.6 whenever `avgTop >= 0.65`. It is dropped rather than
  // ported: `avgTop >= 0.65` already forces `blended >= 0.4875`, so the floor
  // could only ever raise a value that had already cleared 0.45, and 0.6 never
  // reached 0.7. It never changed a verdict at either gate.
  if (blended >= 0.7) return 'strong'
  if (blended >= 0.45) return 'moderate'
  if (blended > 0) return 'weak'
  return 'none'
}

/** Evidence from a bare result count, for stages that only know "how many came back". */
export function assessResultCount(totalResults: number): EvidenceLabel {
  if (totalResults <= 0) return 'none'
  if (totalResults === 1) return 'weak'
  if (totalResults === 2) return 'moderate'
  return 'strong'
}

/**
 * Live query evidence: relevance when the metrics exist, otherwise a count
 * that cannot read as `strong`. Routing coverage floors a confident landing
 * that retrieved none of the entity's linked facts (#238).
 *
 * Count-alone used to map 3+ results → `strong` with no relevance term, so a
 * wrong-subtree pool still looked like a hit. Cap that path at `moderate`.
 */
export function assessQueryEvidence(input: {
  uniqueFacts: number
  avgTop?: number
  conceptCoverage?: number
  routing?: {
    landed: boolean
    linkedCount: number
    retrievedLinkedCount: number
  }
}): EvidenceLabel {
  if (input.uniqueFacts <= 0) return 'none'

  let label: EvidenceLabel
  if (input.avgTop !== undefined && input.conceptCoverage !== undefined) {
    label = assessRetrievalEvidence({
      uniqueFacts: input.uniqueFacts,
      avgTop: input.avgTop,
      conceptCoverage: input.conceptCoverage,
    })
  } else {
    const byCount = assessResultCount(input.uniqueFacts)
    label = byCount === 'strong' ? 'moderate' : byCount
  }

  const routing = input.routing
  if (routing?.landed && routing.linkedCount > 0 && routing.retrievedLinkedCount === 0) {
    return isEvidenceAtLeast(label, 'moderate') ? 'weak' : label
  }
  return label
}
