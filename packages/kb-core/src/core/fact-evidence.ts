/**
 * What kind of evidence a fact is.
 *
 * Facts used to carry a bare `confidence` float chosen at each write site — 0.3
 * for an import edge, 0.65 for an export, 0.6 for a doc sentence. Those numbers
 * were never measured; they encoded an editorial opinion about which shapes of
 * fact say more about their subject. The opinion is reasonable. Writing it as a
 * float made it unreadable, unarguable, and impossible to change without
 * reindexing every fact in the store.
 *
 * So the *label* is what gets stored and what writers (and the LLM extractor)
 * supply — it says what the fact is. The *weight* lives in one table here, is
 * applied at scoring time, and is the only place a number appears.
 *
 * Two things follow from storing the label rather than the number:
 *
 *  1. **Re-weighting needs no reindex.** Change the table, re-run the eval, and
 *     every existing fact is re-scored. That is what makes an ablation of these
 *     weights practical instead of a day of rebuilding indexes.
 *  2. **A model can assign it.** "Is this a definitional statement or an
 *     incidental reference?" is a question an extractor can answer; "is this 0.65
 *     or 0.7?" is not.
 *
 * The weights below reproduce the previous constants exactly, so this change
 * reorders nothing. They are the starting point for measurement, not a result.
 */

/**
 * Ordered weakest to strongest by how much the fact characterizes its subject.
 *
 * - `incidental` — a structural reference that barely describes anything on its
 *   own (`a.ts imports b.ts`).
 * - `contextual` — a statement picked up in passing during a scan.
 * - `descriptive` — an ordinary statement about the subject: prose from a doc, a
 *   definition site, an integration payload.
 * - `declarative` — the subject explicitly declares this (an export).
 * - `definitional` — a relationship that is part of what the subject *is*
 *   (`extends`, `implements`).
 * - `curated` — asserted deliberately: a rescan write, or a caller that supplied
 *   the fact directly rather than having it inferred.
 */
export const FACT_EVIDENCE_KINDS = [
  'incidental',
  'contextual',
  'descriptive',
  'declarative',
  'definitional',
  'curated',
] as const

export type FactEvidenceKind = (typeof FACT_EVIDENCE_KINDS)[number]

/**
 * The one numeric table — a label→weight map for evidence-weighted ranking.
 *
 * NOTE: the hybrid retriever ranks by Reciprocal Rank Fusion over lexical + neural lanes,
 * not by these weights, so `factEvidenceWeight` / `factEvidenceWeightSql` currently have no
 * live caller. The evidence *label* itself is still live (stored on `facts.evidence`, shown
 * by `kb facts`); only the numeric weighting is dormant, kept here as a single source of
 * truth if an evidence-aware re-rank returns.
 *
 * These values are the pre-existing per-write-site constants, each a guess inherited from
 * the float era — not established, and what the ablation harness (#207) exists to test.
 */
const FACT_EVIDENCE_WEIGHTS: Record<FactEvidenceKind, number> = {
  incidental: 0.3,
  contextual: 0.55,
  descriptive: 0.6,
  declarative: 0.65,
  definitional: 0.7,
  curated: 0.8,
}

/** Fallback for rows written before the label existed, or an unrecognized value. */
export const DEFAULT_FACT_EVIDENCE: FactEvidenceKind = 'curated'

export function isFactEvidenceKind(value: unknown): value is FactEvidenceKind {
  return typeof value === 'string' && (FACT_EVIDENCE_KINDS as readonly string[]).includes(value)
}

export function asFactEvidenceKind(value: unknown): FactEvidenceKind {
  return isFactEvidenceKind(value) ? value : DEFAULT_FACT_EVIDENCE
}

/** Ranking weight for a label. The only place a fact's evidence becomes a number. */
export function factEvidenceWeight(kind: FactEvidenceKind | undefined): number {
  return FACT_EVIDENCE_WEIGHTS[kind ?? DEFAULT_FACT_EVIDENCE]
}

/**
 * SQL `CASE` expression yielding the ranking weight, for the one query that has
 * to order by evidence in the database rather than in TypeScript. Kept here so
 * the weights are never written down twice.
 */
export function factEvidenceWeightSql(column: string): string {
  const cases = FACT_EVIDENCE_KINDS.map(
    kind => `WHEN '${kind}' THEN ${FACT_EVIDENCE_WEIGHTS[kind]}`
  ).join(' ')
  return `CASE ${column} ${cases} ELSE ${FACT_EVIDENCE_WEIGHTS[DEFAULT_FACT_EVIDENCE]} END`
}
