# Define intent router and internal-tool boundary

## Ticket ID
055

## Theme
local-kb

## Problem

The harness currently exposes internal operation tools directly in registry. We need an explicit architectural boundary where a router translates consumer intents into internal tool calls.

## Scope
- Define `IntentRouter` abstraction and orchestration flow.
- Define boundary rules: what is public vs internal-only.
- Define policy hooks for choosing write vs append vs update vs merge vs prune.
- Define observability events for routing decisions.

## Acceptance Criteria
- IntentRouter interface defined with stable inputs/outputs.
- Public commands do not require internal tool names.
- Internal tool usage is centralized in router layer.
- Routing decisions are traceable with deterministic audit metadata.
- Security model documents disallowed direct internal tool access for consumer layer.

## Dependencies
004,009,033,047,054

## Deliverables
- Router interface + sequence diagram.
- Boundary policy section (public/internal APIs).
- Decision policy matrix for operation selection.

## Estimate
M

## Priority
HIGH
