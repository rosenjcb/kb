# Add retrieval decision checkpoints and miss-learning loop across tool surfaces

## Ticket ID
071

## Theme
intelligence

## Problem
Current retrieval behavior is stronger than before, but when hybrid/vector retrieval misses or returns low-signal evidence, the system does not consistently escalate through alternate strategies or learn from those misses. This affects `kb chat` and any intent/tool path using `read_documents`.

## Scope
- Define a retrieval decision-checkpoint pipeline for all `read_documents` consumers.
- Add explicit escalation rules (hybrid -> lexical fallback -> alternate query strategy -> bounded workspace fallback where appropriate).
- Add miss-learning capture so repeated miss patterns can improve future retrieval.
- Define telemetry and quality metrics for retrieval checkpoints and miss outcomes.

## Acceptance Criteria
- Retrieval decision checkpoints are documented as deterministic stages with stop/go criteria.
- Miss-learning schema is defined (query fingerprint, miss reason, candidate docs, replay metadata).
- A rollout-safe plan exists for integrating miss-learning signals without degrading precision.
- Validation plan includes measurable before/after retrieval usefulness scenarios.

## Dependencies
065
066
068
070

## Deliverables
- Retrieval decision-checkpoint spec and integration plan.
- Miss-learning data model and storage policy.
- Test/evaluation plan for cross-surface retrieval quality improvement.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Retrieval Decision Checkpoints + Miss-Learning Architecture (Planning SPIKE)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Define deterministic retrieval checkpoint stages and stop/go criteria
	- Define miss-learning schema, safety controls, and integration boundaries
	- Define evaluation + rollout guardrail strategy
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
	- 072: shared retrieval checkpoint orchestrator runtime
	- 073: miss-learning storage + feedback loop runtime
	- 074: evaluation harness + rollout guardrails

#### Background
Retrieval quality has improved, but behavior under low-signal evidence remains inconsistent across surfaces. We need a single decision-checkpoint model and a safe learning loop so misses become future retrieval improvements instead of repeated failures.

#### Approach
Define a shared retrieval lifecycle that every `read_documents` consumer can run. Each stage emits a checkpoint record with explicit outcome, confidence band, and next-step decision. Miss-learning capture is write-path isolated from retrieval serving so data collection can ship before ranking-feedback activation. Ranking feedback remains feature-flagged until evaluation thresholds are met.

#### Examples / Specifications
Checkpoint pipeline (v1):

```text
stage_1: hybrid_primary
	if confidence >= high -> return
	else -> stage_2

stage_2: lexical_recovery
	if confidence >= medium -> return
	else -> stage_3

stage_3: query_rewrite_retry
	if confidence >= medium -> return
	else -> stage_4

stage_4: bounded_workspace_fallback (surface-gated)
	return best effort + uncertainty annotation
```

Checkpoint record shape:

```ts
interface RetrievalCheckpointRecord {
	requestId: string
	stage: 'hybrid_primary' | 'lexical_recovery' | 'query_rewrite_retry' | 'workspace_fallback'
	status: 'hit' | 'partial' | 'miss' | 'error'
	confidence: number
	sourceIds: string[]
	latencyMs: number
	nextAction: 'return' | 'advance'
	reason: string
	createdAt: string
}
```

Miss-learning event shape:

```ts
interface RetrievalMissEvent {
	requestId: string
	queryFingerprint: string
	rawQuery: string
	stage: RetrievalCheckpointRecord['stage']
	missReason:
		| 'no_candidates'
		| 'low_confidence'
		| 'conflicting_sources'
		| 'latency_budget_exceeded'
		| 'provider_error'
	topCandidates: Array<{ id: string; score: number }>
	surface: 'chat' | 'intent-query' | 'intent-explain' | 'validator'
	createdAt: string
}
```

#### Error Conditions / Edge Cases
- Hybrid index unavailable: checkpoint logs `error`, route advances automatically.
- Latency budget exceeded: checkpoint logs explicit reason, no hard failure to caller.
- Zero evidence after final stage: return constrained uncertainty response with transparent stage trace.
- Repeated miss spam: dedupe by query fingerprint + time window before writing miss event.

#### Decisions Made
- ✅ Decided: Use deterministic staged checkpoint pipeline shared across all read surfaces. -> Rationale: consistent behavior and debuggable outcomes.
- ✅ Decided: Separate miss capture from ranking-feedback activation via feature flag. -> Rationale: reduces precision regression risk.
- ✅ Decided: Require evaluation thresholds before enabling feedback loop by default. -> Rationale: prevents unvalidated auto-learning behavior.

#### Integration Points
- Builds on retrieval runtime from tickets 065 and 068.
- Extends reliability controls from ticket 066.
- Supplies implementation work packages in tickets 072, 073, and 074.

#### Validation & Closure
This implementation plan establishes:
- ✅ Deterministic checkpoint stages with stop/go criteria are specified.
- ✅ Miss-learning schema and storage intent are specified.
- ✅ Rollout and validation approach is specified with explicit follow-up tickets.

**Ticket 071 is now closed.**
