/**
 * Extraction pipeline version — "which version of KB's indexing produced this base".
 *
 * A base is re-indexed when its *upstream repo* gains commits. That is the wrong and
 * only trigger when KB's own extraction changes: a repo that has not moved keeps an
 * index built by whatever pipeline was current when it was last scanned, forever. That
 * is how a published fleet ended up serving bases with zero harvested entities weeks
 * after the entity harvest shipped — the repos simply had not been touched since.
 *
 * Stamping the pipeline version per repo makes that state observable and repairable:
 * `auto-sync` re-indexes a repo whose stamp does not match the running code, even with
 * no new commits.
 *
 * **Bump `HARVEST_PIPELINE_VERSION` whenever a change alters what indexing extracts**
 * from unchanged source — new fact kinds, new entity harvesters, new edges. Do not bump
 * it for retrieval/query-side changes, which do not depend on how the index was built.
 */

import type { SqliteKbIndexer } from '../tools/sqlite-kb-index.js'

/**
 * Current extraction pipeline version.
 *
 * History:
 * - 1: entity harvest (`entity-index` cycle) + integration signals.
 * - 2: harvested relationship edges — derived containment for tier-4 entities,
 *   `depends_on` from manifest dependency lists, and resolvable container endpoints.
 */
export const HARVEST_PIPELINE_VERSION = 2

/** `index_state` key holding the pipeline version a repo's facts were extracted with. */
export function pipelineVersionKey(gitRepo?: string): string {
  return gitRepo ? `pipeline_version:${gitRepo}` : 'pipeline_version'
}

/** Version the given repo was last indexed with, or 0 when never stamped. */
export function readPipelineVersion(indexer: SqliteKbIndexer, gitRepo?: string): number {
  const raw = indexer.getIndexStateValue(pipelineVersionKey(gitRepo))
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Record that this repo's index was produced by the running pipeline. */
export function writePipelineVersion(indexer: SqliteKbIndexer, gitRepo?: string): void {
  indexer.setIndexStateValue(pipelineVersionKey(gitRepo), String(HARVEST_PIPELINE_VERSION))
}

/**
 * True when the repo's index predates the running pipeline and must be rebuilt even
 * though its source has not changed.
 */
export function isPipelineStale(indexer: SqliteKbIndexer, gitRepo?: string): boolean {
  return readPipelineVersion(indexer, gitRepo) < HARVEST_PIPELINE_VERSION
}
