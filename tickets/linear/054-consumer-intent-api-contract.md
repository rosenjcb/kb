# Define consumer-intent API contract (public capabilities)

## Ticket ID
054

## Theme
local-kb

## Problem

Current public interaction is too close to internal tool vocabulary (`write_document`, `append_to_document`, etc.). Consumers (human CLI users, Claude Code agents, future clients) should express **intent**, not storage mechanics.

## Scope
- Define public, consumer-facing intent operations.
- Specify request/response schemas for each intent.
- Define capability matrix by consumer type (human CLI, agent CLI, MCP client).
- Ensure internal tool names are not required in public contract.

## Acceptance Criteria
- Public intent verbs are frozen for v1.
- JSON request/response shapes documented and unambiguous.
- Capability matrix exists and clarifies what each consumer can do.
- Internal tool names are explicitly marked implementation details.
- Error shapes are mapped to user-facing language.

## Dependencies
001,004,005,047,053

## Deliverables
- Final public intent contract in this file.
- Mapping table: intent -> internal orchestration path.
- Example payloads for each intent.

## Estimate
M

## Priority
HIGH
