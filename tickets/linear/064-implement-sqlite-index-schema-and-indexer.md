# Implement SQLite index schema and document indexer

## Ticket ID
064

## Theme
intelligence

## Problem
Ticket 063 defined SQLite as a derived retrieval index, but runtime indexing and schema migration are not yet implemented.

## Scope
- Create SQLite schema and migration bootstrap for documents/chunks/fts/embeddings/index_state.
- Implement document reindex pipeline for write/append/update/prune/merge operations.
- Add content-hash based stale detection for lazy reindex.

## Acceptance Criteria
- Schema creation is deterministic and idempotent.
- Indexer updates are triggered correctly for all document write paths.
- Stale detection is reliable and covered by tests.

## Dependencies
063
053

## Deliverables
- SQLite schema implementation.
- Indexer runtime wiring and tests.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Implemented SQLite Schema + Indexer Wiring (Phase: Plan + Code)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- SQLite schema and indexing model confirmed from ticket 063
	- Write-path trigger coverage defined
	- Stale detection semantics defined
- ✅ Phase 2 (Implementation): Complete in this ticket
	- Added SQLite schema/indexer runtime in `src/tools/sqlite-kb-index.ts`
	- Wired index updates into writer operations in `src/tools/markdown-md-writer-tool.ts`
	- Added integration tests in `tests/tools/sqlite-kb-index.test.ts`
- ⏳ Deferred
	- Hybrid retrieval query path and scoring (ticket 065)
	- Rollout/latency guardrails and expanded reliability tests (ticket 066)

#### Background
Ticket 063 established SQLite as a derived index (markdown remains source-of-truth). Ticket 064 implements the schema and mutation-path index updates so later hybrid retrieval can consume indexed content safely.

#### Approach
Implemented a dedicated `SqliteKbIndexer` that owns schema bootstrap and upsert/remove operations. `MarkdownMDWriterTool` now optionally instantiates this indexer (`enableSqliteIndex` or `KB_SQLITE_INDEX=true`) and synchronizes index state on write/append/update/prune, plus merged target sync for auto-merge. Indexing failures are non-fatal and logged, preserving write availability.

#### Examples / Specifications

Implemented schema tables:
- `documents`
- `chunks`
- `chunks_fts` (FTS5)
- `chunk_embeddings`
- `index_state`

Implemented stale detection contract:

```ts
isDocumentStale(filePath: string, content: string): boolean
```

Semantics:
- Returns `true` when document has no indexed hash.
- Returns `false` when `sha256(content)` matches stored hash.
- Returns `true` when content hash differs.

#### Error Conditions / Edge Cases
- SQLite/indexer failure during write mutation: catch and log warning; document write still succeeds.
- Empty/invalid markdown document (missing H1): skipped by index parser to avoid malformed index rows.
- Large section bodies: chunker splits content into bounded-size pieces for stable insert behavior.

#### Decisions Made
- ✅ Decided: Indexing remains optional and feature-gated in writer options/env. -> Rationale: safe incremental rollout.
- ✅ Decided: Use deterministic local vectors in 064 for schema population. -> Rationale: avoids network coupling before ticket 065 retrieval path.
- ✅ Decided: Index sync errors are non-blocking. -> Rationale: markdown persistence is the primary durability path.

#### Integration Points
- Builds directly on ticket 063 architecture decision.
- Enables ticket 065 hybrid retrieval implementation against populated `chunks` + `chunk_embeddings`.
- Reliability/latency hardening deferred to ticket 066.

#### Validation & Closure
This implementation establishes:
- ✅ Acceptance criterion met: schema creation is deterministic and idempotent (bootstrapped in `SqliteKbIndexer.initSchema`).
- ✅ Acceptance criterion met: index updates are triggered on write/append/update/prune and merged target sync.
- ✅ Acceptance criterion met: stale detection implemented and tested via content hash checks.
- ✅ Tests passing: `tests/tools/sqlite-kb-index.test.ts` (3 tests), plus strict TypeScript check.

**Ticket 064 is now closed.**
