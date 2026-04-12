# Implement prune_document tool

## Ticket ID
052

## Theme
local-kb

## Problem

We need surgical content removal (section-level prune) without deleting entire documents.

## Scope
- Add `prune_document` with section/pattern-based removal.
- Return clear not-found-section errors.
- Preserve document metadata and update index timestamp.
- Keep rollback strategy aligned with git-history retention.

## Acceptance Criteria
- Tool exists with schema (`documentId`, `prunePattern`).
- Matching section/content is removed deterministically.
- Non-matching pattern returns descriptive error.
- Index row updated after prune.
- Tests cover successful prune and no-match error.

## Dependencies
005,007,013,047

## Deliverables
- prune_document implementation and registry wiring.
- pattern matching rules documented.
- unit tests for prune behavior.

## Estimate
S

## Priority
HIGH
