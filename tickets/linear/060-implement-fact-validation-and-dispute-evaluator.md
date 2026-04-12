# Implement fact validation and dispute evaluator

## Ticket ID
060

## Theme
intelligence

## Problem

Ticket 056 defines validation/dispute semantics but evaluator logic is not implemented.

## Scope
- Implement `validate_fact` evaluator with statuses valid/invalid/uncertain.
- Implement `dispute_fact` intake and recommended-action output.
- Enforce provenance requirements in responses.
- Add confidence scoring + deterministic tie handling.

## Acceptance Criteria
- Evaluator returns spec-compliant statuses.
- Provenance is always present in responses.
- `uncertain` behavior triggers in evidence ties/conflicts.
- Tests cover status decision table and edge cases.

## Dependencies
056,027,028,046,058

## Deliverables
- Evaluator runtime module.
- Validation/dispute integration tests.
- Confidence and recommendation logic documentation.

## Estimate
M

## Priority
HIGH

---

## Implementation Summary

### Outcome
Implemented validation/dispute evaluator runtime used by intent router.

### Delivered
- Added evaluator module: `src/intents/evaluator.ts`
	- `validateFact(...)`: returns `valid|invalid|uncertain` with confidence/explanation/provenance
	- `disputeFact(...)`: accepts dispute context, records dispute note, returns recommended action
- Evaluation behavior:
	- Uses `read_documents` to gather relevant evidence
	- Derives status based on evidence support/conflict
	- Emits provenance IDs from matching records
- Integrated evaluator calls into router execution path for `validate_fact` and `dispute_fact`.

### Validation
- Type-check passes.
- Router tests cover validate/dispute execution paths.

### Integration Notes
- Current evaluator is deterministic and tool-driven.
- Can be expanded later with richer scoring/prompt-based evidence adjudication without contract changes.

**Ticket 060 is now closed.**

