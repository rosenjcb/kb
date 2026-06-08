/**
 * Schema types for context compaction telemetry.
 *
 * Full compaction execution is deferred until moel-run.mjs drives agent turns
 * in-process rather than via subprocess (see TICKET-011). This file provides
 * the schema so MoelResult can carry compaction fields today.
 */

export interface CompactionEvent {
  stepIndex: number
  tokensFreed: number
  turnsCompacted: number
  condition: 'N' | 'K' | 'O'
}

export interface CompactionRecord {
  triggered: boolean
  events: CompactionEvent[]
}

/** Factory: returns an empty compaction record (no compaction occurred). */
export function buildEmptyCompactionRecord(): CompactionRecord {
  return { triggered: false, events: [] }
}
