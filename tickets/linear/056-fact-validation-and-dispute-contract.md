# Specify fact validation and dispute contract

## Ticket ID
056

## Theme
intelligence

## Problem

Consumers need high-level truth workflows: validate fact, dispute fact, and receive why/why-not explanations. Today this behavior is implicit and not contract-defined.

## Scope
- Define `validate_fact` consumer intent contract.
- Define `dispute_fact` consumer intent contract.
- Define response statuses: valid | invalid | uncertain.
- Define required explanation/provenance fields.
- Define follow-up action recommendations when invalid/uncertain.

## Acceptance Criteria
- Validation/dispute schemas are explicit and testable.
- Status semantics are unambiguous.
- Provenance fields are required in responses.
- Error and uncertainty handling are specified.
- Examples cover CLI and agent client usage.

## Dependencies
003,005,027,028,046,054

## Deliverables
- Full contract spec with sample payloads.
- Decision table for status assignment.
- Integration notes for check/deep_validation flows.

## Estimate
M

## Priority
HIGH

---

## Implementation Plan

### Fact Validation and Dispute Semantics v1

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- `validate_fact` + `dispute_fact` contracts defined
	- Status semantics and provenance requirements frozen
	- Recommendation semantics defined
- ⏳ Phase 2 (Implementation): Deferred
	- Evaluator and scoring runtime deferred to tickets 058 and 060

#### Background
Consumers need explicit truth workflows: validate existing facts and dispute incorrect ones with clear explanation and provenance.

#### Approach
Define two intents with strict response schema. `validate_fact` determines status (`valid|invalid|uncertain`) and provides confidence/evidence. `dispute_fact` submits counter-evidence and returns recommended action path.

#### Examples / Specifications
`validate_fact` request:

```json
{
	"intent": "validate_fact",
	"payload": {
		"fact": "Deployments require feature flag X.",
		"domain": "operations",
		"expectedSource": ["deploy-runbook"]
	}
}
```

`validate_fact` response:

```json
{
	"status": "valid",
	"confidence": 0.86,
	"explanation": "Fact matches current runbook section and recent updates.",
	"provenance": ["deploy-runbook", "ticket-052"],
	"recommendedAction": "none"
}
```

`dispute_fact` response:

```json
{
	"status": "accepted",
	"disputeId": "disp_445",
	"recommendedAction": "update_document",
	"reason": "Counter-evidence supersedes outdated runbook section.",
	"provenance": ["incident-2026-04-12", "postmortem-12"]
}
```

Status decision table:

| Status | Meaning |
|---|---|
| valid | Evidence supports fact |
| invalid | Evidence contradicts fact |
| uncertain | Insufficient/conflicting evidence |

#### Error Conditions / Edge Cases
- Missing provenance in response is invalid contract.
- Conflicting evidence with equal weight returns `uncertain`.
- Unsupported domain returns `UNSUPPORTED_DOMAIN`.
- Dispute with no counter-evidence returns `INVALID_PAYLOAD`.

#### Decisions Made
- ✅ Decided: Validation statuses are exactly `valid|invalid|uncertain`.
	- Rationale: Predictable client branching.
- ✅ Decided: Provenance is required for all validate/dispute responses.
	- Rationale: Explainability and trust.
- ✅ Decided: Responses must include `recommendedAction`.
	- Rationale: Enables deterministic next step in router/CLI.
- ✅ Decided: Tie/conflict cases resolve to `uncertain` (not auto-invalid).
	- Rationale: Safety over overconfident classification.

#### Integration Points
- Ticket 054 defines public intent envelope.
- Ticket 055 routes these intents into internal operations.
- Ticket 057 defines CLI outputs for these statuses.
- Ticket 060 implements evaluator/scoring runtime.

#### Validation & Closure
This implementation plan establishes:
- ✅ Validation and dispute schemas are explicit.
- ✅ Status semantics are deterministic.
- ✅ Provenance and action recommendation requirements are defined.
- ✅ Edge/error behavior is specified.

**Ticket 056 is now closed.**

