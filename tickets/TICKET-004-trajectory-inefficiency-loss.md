# TICKET-004: Trajectory Inefficiency Loss (`L_trajectory`)

**Status:** Implemented  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, trajectory

## Context

An agent that arrives at a correct answer via 30 redundant file reads is less efficient than one that takes 4 targeted fact lookups. Binary pass/fail cannot distinguish these cases. The trajectory loss penalizes two behaviors: taking more steps than the optimal path, and repeating tool calls.

The optimal path for a kb-style task is defined in terms of the kb fact graph: given target symbols, what is the minimal set of `read_facts` or `get_code_neighbors` calls required to retrieve the facts that cover those symbols? This can be computed by static traversal of the SQLite fact graph that kb builds during `kb init`.

## Objective

Implement `computeTrajectoryLoss(trajectory: TrajectoryFile, optimalActions: string[], hLimit: number): number` that returns a normalized loss in `[0, 1]`.

## Acceptance Criteria

- [ ] Step deviation component: `min(totalSteps / hLimit, 1.0)`.
- [ ] Redundancy ratio: duplicate tool calls (same `toolName` + normalized `arguments`) divided by `max(totalSteps, 1)`.
- [ ] Final loss: `0.5 * stepDeviation + 0.5 * redundancyRatio`, clamped to `[0, 1]`.
- [ ] Arguments are normalized before duplicate detection: sort object keys, trim whitespace, stringify.
- [ ] Default `hLimit = 20`, configurable per task.
- [ ] `buildOptimalActionSet(dbPath: string, targetSymbols: string[]): Promise<string[]>` queries the kb SQLite database (at `dbPath`) to find the minimal set of fact IDs reachable from the given target symbols via `fact_edges`. This is the oracle path for Condition K. For Condition N (filesystem), the optimal action set is the minimal set of `read_file` calls on the files that contain the target symbols.
- [ ] Unit tests cover: optimal path taken → low loss, same tool called 5 times → high redundancy, step count at ceiling → step component = 1.0.

## Schema Reference

### `facts` table (migration v5 + v8 + v12)

```sql
CREATE TABLE facts (
  id               TEXT PRIMARY KEY,           -- e.g. "fact-<16-char-hex>"
  fact_text        TEXT NOT NULL,
  normalized_text  TEXT NOT NULL,              -- lowercase, collapsed whitespace
  source_kind      TEXT NOT NULL,              -- 'import_doc' | 'import_code'
  source_ref       TEXT,                       -- e.g. "code:src/foo.ts@computeLoss"
  confidence       REAL NOT NULL DEFAULT 0.8,
  supersedes_fact_id TEXT,
  tombstoned_at    TEXT,                       -- NULL means active
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT '',   -- triplet subject
  predicate        TEXT NOT NULL DEFAULT '',   -- 'imports' | 'exported_from' | 'asserts' | ...
  object           TEXT NOT NULL DEFAULT '',   -- triplet object
  source_text      TEXT,                       -- raw code snippet for import_code facts
  lane_id          TEXT NOT NULL DEFAULT 'general'
);
```

Relevant columns for BFS traversal: `id`, `tombstoned_at` (filter to active), `subject`, `predicate`, `object`, `source_kind`, `source_ref`.

### `fact_edges` table (migration v5)

```sql
CREATE TABLE fact_edges (
  from_fact_id  TEXT NOT NULL,
  to_fact_id    TEXT NOT NULL,
  edge_type     TEXT NOT NULL,   -- 'concept_overlap' | 'imports_symbol'
  weight        REAL NOT NULL DEFAULT 1.0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (from_fact_id, to_fact_id, edge_type),
  FOREIGN KEY (from_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (to_fact_id)   REFERENCES facts(id) ON DELETE CASCADE
);
```

`edge_type` values seen in the codebase:
- `'concept_overlap'` — written by `rebuildFactGraph()` in `SqliteKbIndexer` when two facts share concept tokens
- `'imports_symbol'` — written by `relinkCodeImportEdges()` linking `predicate = 'imports'` facts to `predicate = 'exported_from'` facts for the same symbol

### `code_file_state` table (migration v14)

```sql
CREATE TABLE code_file_state (
  file_path     TEXT PRIMARY KEY,   -- relative path to source file, e.g. "src/core/db-migrations.ts"
  content_hash  TEXT NOT NULL,
  extractor     TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);
```

`code_file_state` records which files were indexed but does **not** directly map symbols to files. To map target symbols to source files for Condition N, query `facts` where `source_kind = 'import_code'` and match the symbol name against `subject`, `object`, or `source_ref` (which uses the pattern `code:<file_path>@<symbol>`).

## Implementation Notes

### Import Pattern (`node:sqlite`)

Follow `src/tools/sqlite-kb-index.ts` exactly — no new database dependency:

```typescript
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
// run migrations so the schema is guaranteed present:
runMigrations(db)
```

Prepared statements use `.prepare(sql).all(...params)` for multiple rows and `.prepare(sql).get(...params)` for a single row. Parameters are positional `?` placeholders for arrays or named `@key` placeholders for objects passed to `.run({ key: value })`.

### Optimal Path for Condition K — `buildOptimalActionSet`

Seed the BFS from `facts` rows whose `subject`, `object`, or `source_ref` match the target symbol strings, then expand via `fact_edges` (both directions) up to depth 2. Each collected fact ID is one `read_facts` call in the oracle path.

```typescript
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../src/core/db-migrations'

export function buildOptimalActionSet(
  dbPath: string,
  targetSymbols: string[]
): string[] {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)

  // 1. Seed: find fact IDs whose triplet or source_ref mentions any target symbol.
  //    source_ref pattern for code facts is "code:<path>@<symbol>".
  const seen = new Set<string>()
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

  // 2. BFS expansion — two hops, bidirectional edges.
  //    Mirrors getFactNeighbors() in SqliteKbIndexer.
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

  // 3. Filter to non-tombstoned facts only (neighbors may reference deleted facts).
  if (seen.size === 0) return []
  const allIds = [...seen]
  const placeholders = allIds.map(() => '?').join(', ')
  const active = db
    .prepare(
      `SELECT id FROM facts WHERE id IN (${placeholders}) AND tombstoned_at IS NULL`
    )
    .all(...allIds) as Array<{ id: string }>

  db.close()
  return active.map(row => row.id)
}
```

### Optimal Path for Condition N — Symbol-to-File Mapping

For the raw filesystem agent, query `facts` to derive which source files contain the target symbols, then emit one `read_file` call per distinct file path. `code_file_state` alone is insufficient (it records indexed files, not symbol locations); use `source_ref` on `facts` rows with `source_kind = 'import_code'`:

```typescript
// source_ref format: "code:src/path/to/file.ts@SymbolName"
function symbolsToFilePaths(db: DatabaseSync, targetSymbols: string[]): string[] {
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
      // Strip "code:" prefix and "@SymbolName" suffix to get bare file path.
      const match = row.source_ref.match(/^code:(.+?)@/)
      if (match) filePaths.add(match[1])
    }
  }
  return [...filePaths]
}
```

### Argument Normalization

```typescript
function normalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, Object.keys(args).sort())
}
```

## Files to Create

- `eval/losses/trajectory-loss.ts`

## Files to Reference (do not modify)

- `src/tools/sqlite-kb-index.ts` — SQLite query patterns; specifically `getFactNeighbors()` (line 565) for the BFS UNION pattern, and `rebuildFactGraph()` (line 1267) for edge insertion logic
- `src/core/db-migrations.ts` — authoritative schema; `fact_edges` at migration v5 (line 225), `code_file_state` at migration v14 (line 461), `facts` triplet columns at migration v8 (line 302)

## Dependencies

TICKET-001 (`TrajectoryFile` type)

## Feeds Into

TICKET-006
