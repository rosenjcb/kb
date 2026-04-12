# Implement consumer-intent API and IntentRouter runtime

## Ticket ID
058

## Theme
local-kb

## Problem

Tickets 054 and 055 define a public intent contract and router boundary, but runtime implementation is not yet in place.

## Scope
- Implement public intent envelope handling.
- Implement `IntentRouter` runtime mapping intents to internal operations.
- Add policy/audit reason metadata per route.
- Ensure consumer layer cannot directly invoke internal tool operations.

## Acceptance Criteria
- Intents are executable end-to-end through router.
- Route decisions include explainable `policyReason`.
- Internal tool calls remain internal-only in public mode.
- Integration tests cover all five intents.

## Dependencies
054,055,053

## Deliverables
- Router implementation in runtime.
- Public intent entrypoint integration.
- Integration tests and audit event checks.

## Estimate
M

## Priority
HIGH

---

## Implementation Summary

### Outcome
Implemented consumer-intent routing runtime with a dedicated `IntentRouter` and end-to-end execution path through existing tool infrastructure.

### Delivered
- Added intent runtime module set:
	- `src/intents/types.ts`
	- `src/intents/router.ts`
	- `src/intents/index.ts`
- Implemented `DefaultIntentRouter` with:
	- Route decision logic for `submit_fact`, `validate_fact`, `dispute_fact`, `query_truth`, `explain_change`
	- Policy rationale per route (`policyReason`)
	- Execution path from intent to internal operation via tool executor
- Added router tests: `tests/intents/router.test.ts`

### Validation
- Type-check passes.
- Unit tests pass including new router coverage.

### Integration Notes
- Router is currently invoked from CLI intent mode (ticket 059 implementation).
- Internal operation selection stays centralized in router logic.

**Ticket 058 is now closed.**

