# Implement merge_documents tool

## Ticket ID
051

## Theme
local-kb

## Problem

We need dedicated document merge behavior with two modes (`auto`, `user-decides`) and deterministic conflict handling from ticket 047.

## Scope
- Add `merge_documents` tool and schema.
- Implement `mergeMode`: `auto` and `user-decides`.
- Implement deterministic merge status and response envelope.
- Integrate LLM-based semantic similarity (primary) with fuzzy fallback.

## Acceptance Criteria
- Tool exists with schema (`sourceDocId`, `targetDocId`, `mergeMode`).
- `user-decides` mode returns pending/approval-needed response.
- `auto` mode executes deterministic merge path.
- Similarity check uses LLM semantic similarity with fallback.
- Tests cover both modes and ambiguity/error paths.

## Dependencies
004,005,018,047

## Deliverables
- merge_documents implementation + registry wiring.
- similarity helper + conflict status mapping.
- unit/integration tests for merge scenarios.

## Estimate
M

## Priority
HIGH
