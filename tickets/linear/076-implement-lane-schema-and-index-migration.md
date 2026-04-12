# Implement retrieval lane schema and index migration

## Ticket ID
076

## Theme
intelligence

## Problem
Typed-lane retrieval requires explicit lane schema and indexed lane metadata before runtime routing can be enforced safely.

## Scope
- Add lane taxonomy schema (`error-runbook`, `fact`, `policy`, `architecture`, `session-log`, `workflow`).
- Add lane metadata persistence in SQLite document/chunk index structures.
- Add migration/backfill path for existing documents.

## Acceptance Criteria
- Lane metadata is persisted and queryable in index tables.
- Existing documents can be backfilled to lanes deterministically.
- Tests cover schema migration and lane assignment behavior.

## Dependencies
075
064
073

## Deliverables
- Schema migration + backfill runtime.
- Tests for lane persistence and migration safety.

## Estimate
M

## Priority
High
