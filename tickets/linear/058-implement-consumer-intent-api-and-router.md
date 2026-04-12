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
