# Implement append_to_document tool

## Ticket ID
049

## Theme
local-kb

## Problem

Decision logs and running notes need append semantics without full document replacement. This must be first-class, separate from `write_document`.

## Scope
- Add `append_to_document` tool contract and registry wiring.
- Support append position (`bottom` default, optional `top`).
- Preserve title/created timestamp metadata.
- Update index timestamp after append.

## Acceptance Criteria
- Tool exists with explicit schema (`documentId`, `content`, optional `position`).
- Appends content to existing document safely.
- Returns clear error for non-existent document.
- Index `updated_at` is refreshed.
- Tests cover top/bottom append and not-found case.

## Dependencies
007,013,047

## Deliverables
- append_to_document tool implementation and registration.
- Validation + error mapping.
- Unit tests + scenario examples.

## Estimate
S

## Priority
HIGH
