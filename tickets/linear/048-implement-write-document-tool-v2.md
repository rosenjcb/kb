# Implement write_document tool v2 (specialized create semantics)

## Ticket ID
048

## Theme
local-kb

## Problem

`write_document` currently exists but needs to be aligned with the specialized tool architecture from ticket 047 and remain the strict "create/write" operation (not append/merge/prune polymorphism).

## Scope
- Keep `write_document` focused on create/write semantics.
- Ensure overwrite + collision behavior remains consistent with ticket 008.
- Align schema/validation with updated `DocumentWriter` contracts.
- Preserve index update behavior (`_table.md`).

## Acceptance Criteria
- `write_document` only handles create/write semantics.
- Input schema is explicit and validated.
- Collision/overwrite behavior matches ticket 008.
- Index update verified for create and overwrite paths.
- Tests cover successful write, overwrite, and collision suffix behavior.

## Dependencies
002,007,008,047

## Deliverables
- Updated write_document registration and handler.
- Updated schema and parser validation.
- Unit tests for create/overwrite/collision.

## Estimate
S

## Priority
HIGH
