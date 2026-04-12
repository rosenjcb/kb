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

---

## Implementation Plan

### Consumer-Intent Public Contract v1

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Public intent vocabulary frozen
	- Request/response contracts defined
	- Capability model by consumer finalized
- ⏳ Phase 2 (Implementation): Deferred
	- API/router implementation in follow-up tickets (058, 059, 061)

#### Background
Consumers should state what they want (submit, validate, dispute, query), not how storage tools execute operations (`write_document`, `append_to_document`, etc.). This ticket defines the public capability contract and hides internal orchestration vocabulary.

#### Approach
Define a stable intent API with five operations: `submit_fact`, `validate_fact`, `dispute_fact`, `query_truth`, `explain_change`. Each operation has explicit request/response schemas and user-facing error shapes. Internal tool names are marked implementation detail only and are not exposed in consumer contract docs.

#### Examples / Specifications
Public envelope:

```json
{
	"intent": "submit_fact",
	"requestId": "req_123",
	"payload": {}
}
```

Supported intents:

```ts
type ConsumerIntent =
	| 'submit_fact'
	| 'validate_fact'
	| 'dispute_fact'
	| 'query_truth'
	| 'explain_change'
```

`submit_fact` request/response:

```json
{
	"intent": "submit_fact",
	"payload": {
		"fact": "Deployment requires feature flag X enabled.",
		"domain": "operations",
		"confidence": "high",
		"source": "runbook-v3"
	}
}
```

```json
{
	"status": "accepted",
	"truthId": "truth_8f2",
	"appliedOperation": "append_to_document",
	"explanation": "Fact appended to existing operations runbook.",
	"provenance": ["runbook-v3"]
}
```

Capability matrix:

| Consumer | Allowed intents | Notes |
|---|---|---|
| Human CLI | All 5 | Natural language or structured JSON |
| Agent CLI | All 5 | Must include requestId for traceability |
| MCP Client | All 5 | Contract-first JSON mode |

#### Error Conditions / Edge Cases
- Unknown intent → `INVALID_INTENT`
- Missing required fields → `INVALID_PAYLOAD`
- Unsupported domain → `UNSUPPORTED_DOMAIN`
- Intent accepted but not immediately resolved → `PENDING_REVIEW`

Standard error shape:

```json
{
	"status": "error",
	"code": "INVALID_PAYLOAD",
	"message": "submit_fact.payload.fact is required",
	"retryable": false
}
```

#### Decisions Made
- ✅ Decided: Public API is intent-based, not tool-based.
	- Rationale: Stable consumer UX, internal tooling can evolve independently.
- ✅ Decided: Exactly five v1 intents.
	- Rationale: Covers core workflows without premature expansion.
- ✅ Decided: Internal tool names are implementation detail.
	- Rationale: Enforces separation of concerns and prevents contract leakage.
- ✅ Decided: Uniform envelope + error shape across all intents.
	- Rationale: Simpler clients, consistent observability.

#### Integration Points
- Ticket 055 defines the `IntentRouter` boundary.
- Ticket 056 defines deep semantics for validate/dispute outcomes.
- Ticket 057 defines CLI UX/commands for these intents.
- Ticket 058 implements API + router execution path.

#### Validation & Closure
This implementation plan establishes:
- ✅ Public intent verbs frozen for v1.
- ✅ Request/response contracts and error shapes defined.
- ✅ Capability matrix by consumer type documented.
- ✅ Internal tools explicitly marked as non-public.

**Ticket 054 is now closed.**

