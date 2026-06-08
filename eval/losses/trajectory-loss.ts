/**
 * Trajectory Inefficiency Loss (L_trajectory)
 *
 * Penalizes two failure modes in agent trajectories:
 *   1. Taking more steps than the configured ceiling (step deviation)
 *   2. Repeating the same tool call with identical arguments (redundancy)
 *
 * Formula: 0.5 * stepDeviation + 0.5 * redundancyRatio, clamped to [0, 1].
 *
 * buildOptimalActionSet() derives the oracle fact IDs for Condition K by
 * querying the kb SQLite database (requires kb init to have been run).
 */

import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../../src/core/db-migrations'
import type { TrajectoryFile, TrajectoryStep } from '../../src/core/telemetry'

// Normalize tool call arguments for duplicate detection: sort keys, trim strings.
function normalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, Object.keys(args).sort())
}

function countDuplicates(steps: TrajectoryStep[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const step of steps) {
    const key = `${step.toolName}:${normalizeArgs(step.arguments)}`
    if (seen.has(key)) {
      duplicates++
    } else {
      seen.add(key)
    }
  }
  return duplicates
}

/**
 * Compute trajectory inefficiency loss.
 *
 * @param trajectory - compiled trajectory from TrajectoryCollector
 * @param _optimalActions - oracle fact/file IDs for this task (reserved for
 *   future path-deviation scoring; not yet used in the formula)
 * @param hLimit - maximum step ceiling (default 20)
 */
export function computeTrajectoryLoss(
  trajectory: TrajectoryFile,
  _optimalActions: string[],
  hLimit = 20
): number {
  const totalSteps = trajectory.totalSteps

  if (totalSteps === 0) return 0

  const stepDeviation = Math.min(totalSteps / hLimit, 1.0)
  const redundancyRatio = countDuplicates(trajectory.steps) / Math.max(totalSteps, 1)

  return Math.min(0.5 * stepDeviation + 0.5 * redundancyRatio, 1.0)
}

/**
 * Build the oracle optimal action set for Condition K by BFS over the kb fact graph.
 *
 * Seeds from facts whose subject, object, or source_ref mentions any target symbol,
 * then expands bidirectionally via fact_edges up to 2 hops. Returns active fact IDs.
 *
 * Requires that kb init has been run against the repo at dbPath.
 */
export function buildOptimalActionSet(dbPath: string, targetSymbols: string[]): string[] {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)

  try {
    const seen = new Set<string>()

    // Seed: find fact IDs whose triplet or source_ref mentions any target symbol.
    // source_ref format for code facts: "code:<path>@<SymbolName>"
    for (const symbol of targetSymbols) {
      const like = `%${symbol}%`
      const rows = db
        .prepare(
          `SELECT id FROM facts
           WHERE tombstoned_at IS NULL
             AND (subject LIKE ? OR object LIKE ? OR source_ref LIKE ?)
           LIMIT 50`
        )
        .all(like, like, like) as Array<{ id: string }>
      for (const row of rows) seen.add(row.id)
    }

    // BFS: two hops, bidirectional edges (mirrors getFactNeighbors in sqlite-kb-index.ts).
    const BFS_DEPTH = 2
    let frontier = [...seen]
    for (let hop = 0; hop < BFS_DEPTH && frontier.length > 0; hop++) {
      const placeholders = frontier.map(() => '?').join(', ')
      const neighborRows = db
        .prepare(
          `SELECT DISTINCT to_fact_id   AS neighbor_id FROM fact_edges WHERE from_fact_id IN (${placeholders})
           UNION
           SELECT DISTINCT from_fact_id AS neighbor_id FROM fact_edges WHERE to_fact_id   IN (${placeholders})`
        )
        .all(...frontier, ...frontier) as Array<{ neighbor_id: string }>

      const next: string[] = []
      for (const row of neighborRows) {
        if (!row.neighbor_id || seen.has(row.neighbor_id)) continue
        seen.add(row.neighbor_id)
        next.push(row.neighbor_id)
      }
      frontier = next
    }

    if (seen.size === 0) return []

    // Filter to non-tombstoned facts only.
    const allIds = [...seen]
    const placeholders = allIds.map(() => '?').join(', ')
    const active = db
      .prepare(
        `SELECT id FROM facts WHERE id IN (${placeholders}) AND tombstoned_at IS NULL`
      )
      .all(...allIds) as Array<{ id: string }>

    return active.map(row => row.id)
  } finally {
    db.close()
  }
}

/**
 * For Condition N, map target symbols to the source files that contain them.
 * Derives file paths from facts.source_ref (pattern: "code:<path>@<Symbol>").
 */
export function buildConditionNOptimalFiles(dbPath: string, targetSymbols: string[]): string[] {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  runMigrations(db)

  try {
    const filePaths = new Set<string>()
    for (const symbol of targetSymbols) {
      const like = `code:%@${symbol}`
      const rows = db
        .prepare(
          `SELECT source_ref FROM facts
           WHERE tombstoned_at IS NULL
             AND source_kind = 'import_code'
             AND source_ref LIKE ?
           LIMIT 20`
        )
        .all(like) as Array<{ source_ref: string | null }>
      for (const row of rows) {
        if (!row.source_ref) continue
        const match = row.source_ref.match(/^code:(.+?)@/)
        if (match) filePaths.add(match[1])
      }
    }
    return [...filePaths]
  } finally {
    db.close()
  }
}
