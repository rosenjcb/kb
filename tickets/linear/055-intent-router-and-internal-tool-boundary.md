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

---

## Implementation Plan

### Intent Router Boundary and Internal Tool Isolation

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- `IntentRouter` interface and flow specified
	- Public/internal boundary rules defined
	- Routing policy matrix documented
- ⏳ Phase 2 (Implementation): Deferred
	- Runtime router implementation deferred to tickets 058 and 061

#### Background
Today, internal operations are directly exposed in tool registry semantics. We need a strict boundary: consumers call intents, router chooses internal operations.

#### Approach
Introduce `IntentRouter` as a dedicated orchestration layer between consumer-facing API and internal tool executor. The router enforces policy, chooses operations deterministically, records routing rationale, and returns consumer-safe responses.

#### Examples / Specifications
Router interface:

```ts
interface IntentRouter {
	route(intent: ConsumerIntentEnvelope, context: RouteContext): Promise<RouteResult>
}

interface RouteResult {
	selectedOperation: 'write' | 'append' | 'update' | 'merge' | 'prune' | 'query'
	operationInput: Record<string, unknown>
	policyReason: string
}
```

Flow sketch:

```text
Consumer -> Intent API -> IntentRouter -> Internal Tool Executor -> Storage
										 \-> Audit/Event Log (selection rationale)
```

Boundary rules:
- Public layer exposes only intents.
- Internal tools are callable only by router.
- Direct consumer access to `*_document` operations is denied in public mode.

Policy matrix:

| Intent | Typical route |
|---|---|
| submit_fact | append or write |
| validate_fact | query (+ evaluator) |
| dispute_fact | prune / update / merge-pending |
| query_truth | query |
| explain_change | query audit trail |

#### Error Conditions / Edge Cases
- Router cannot determine safe operation → return `PENDING_REVIEW`.
- Conflicting policy signals (e.g., duplicate + low confidence) → route to `merge-pending-approval`.
- Internal tool failure → mapped to consumer-safe `INTERNAL_OPERATION_FAILED`.

#### Decisions Made
- ✅ Decided: Router is mandatory for public intent execution.
	- Rationale: Prevents internal vocabulary leakage.
- ✅ Decided: Direct internal tool usage is disallowed in public mode.
	- Rationale: Security and UX consistency.
- ✅ Decided: Every route includes `policyReason` and emits audit metadata.
	- Rationale: Explainability and debugging.
- ✅ Decided: Fallback state is `PENDING_REVIEW` over unsafe auto-action.
	- Rationale: Minimize destructive or incorrect writes.

#### Integration Points
- Ticket 054 provides public contract that router consumes.
- Ticket 056 provides validate/dispute decision semantics.
- Ticket 058 implements router runtime behavior.
- Ticket 061 enforces boundary policy at registry/transport level.

#### Validation & Closure
This implementation plan establishes:
- ✅ Router abstraction with stable I/O.
- ✅ Public/internal boundary policy.
- ✅ Deterministic routing policy table.
- ✅ Auditability requirements for route decisions.

**Ticket 055 is now closed.**

