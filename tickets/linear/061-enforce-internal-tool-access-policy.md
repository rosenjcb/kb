# Enforce internal tool access policy for consumer-facing flows

## Ticket ID
061

## Theme
reliability

## Problem

Even with intent APIs, accidental exposure of internal operations can leak implementation details and violate separation-of-concerns.

## Scope
- Enforce policy gate preventing direct consumer invocation of internal tools.
- Add explicit allowlist for public intents and denylist for internal operations.
- Emit observability events for blocked attempts.
- Define security/error mapping for policy violations.

## Acceptance Criteria
- Public mode blocks direct `*_document` operation calls from consumers.
- Policy violations return stable consumer-safe errors.
- Audit events emitted for each denial.
- Tests cover allowlist/denylist behavior.

## Dependencies
055,058,059,033,021

## Deliverables
- Policy enforcement layer.
- Error mapping + event emission updates.
- Contract tests for policy behavior.

## Estimate
S

## Priority
HIGH

---

## Implementation Summary

### Outcome
Implemented consumer-facing policy gate that blocks direct internal tool invocation by default.

### Delivered
- Added policy module: `src/intents/policy.ts`
	- Internal operation denylist (`write_document`, `append_to_document`, `update_document`, `merge_documents`, `prune_document`, `read_documents`)
	- Guard: `assertConsumerSafeCommand(...)`
	- Explicit override: `KB_ALLOW_INTERNAL_TOOLS=true`
- Enforcement points:
	- CLI main flow (`src/cli/index.ts`) denies direct internal tool command attempts
	- Intent parser path (`src/cli/intent-cli.ts`) applies same safety guard

### Validation
- Type-check passes.
- CLI intent tests include command classification and behavior checks.

### Integration Notes
- Policy is focused on consumer command boundary.
- Internal tools remain usable by router/orchestrator runtime.

**Ticket 061 is now closed.**

