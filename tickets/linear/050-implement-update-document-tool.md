# Implement update_document tool

## Ticket ID
050

## Theme
local-kb

## Problem

Reference docs and runbooks need whole-document replacement without relying on `write_document` mode polymorphism.

## Scope
- Add `update_document` as dedicated replacement tool.
- Preserve `createdAt`; refresh `updatedAt`.
- Allow optional title update.
- Maintain index consistency.

## Acceptance Criteria
- Tool exists with explicit schema (`documentId`, `content`, optional `title`).
- Existing document is replaced atomically.
- `createdAt` is preserved; `updatedAt` changes.
- Index row is updated.
- Tests cover replace, title-change, not-found behavior.

## Dependencies
007,013,047

## Deliverables
- update_document tool implementation and registry wiring.
- Parser validation and error behavior.
- Unit tests.

## Estimate
S

## Priority
HIGH
