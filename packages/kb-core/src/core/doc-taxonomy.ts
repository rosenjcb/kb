/**
 * Document taxonomy — the categories KB stores for whole documents.
 *
 * Distinct from `FactLaneId` ([fact-taxonomy.ts](./fact-taxonomy.ts)), which categorizes
 * individual facts for retrieval lane routing. Distinct from `RetrievalLane`
 * ([../tools/retrieval-lane-router.ts](../tools/retrieval-lane-router.ts)), which is the
 * runtime retrieval routing concept.
 *
 * `DocType` drives:
 *   - document classification in `SqliteDocumentWriter` (not the agent `read_facts` schema)
 *   - init synthesis output type
 */

export const DOC_TYPES = ['howto', 'introduction', 'reference', 'decision', 'runbook'] as const

export type DocType = (typeof DOC_TYPES)[number]

export function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value)
}

/**
 * Legacy doc_type values predating the redesign. Used by the v7 migration
 * and as a read-side fallback so any rows that escape migration still resolve
 * to a valid `DocType`.
 */
export const LEGACY_DOC_TYPE_REMAP: Record<string, DocType> = {
  architecture: 'reference',
  checklist: 'runbook',
}

/** Coerce a stored string into a `DocType`, applying the legacy remap. Returns `undefined` when not resolvable. */
export function coerceDocType(value: unknown): DocType | undefined {
  if (typeof value !== 'string') return undefined
  if (isDocType(value)) return value
  return LEGACY_DOC_TYPE_REMAP[value]
}
