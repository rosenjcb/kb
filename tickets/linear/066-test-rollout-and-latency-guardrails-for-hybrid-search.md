# Add tests, rollout controls, and latency guardrails for hybrid search

## Ticket ID
066

## Theme
reliability

## Problem
Hybrid retrieval introduces new operational risks around latency, index freshness, and degraded provider behavior.

## Scope
- Expand test matrix for correctness, regressions, and fallback scenarios.
- Define and enforce latency budgets for query execution.
- Add rollout controls and observability hooks for safe enablement.

## Acceptance Criteria
- Test suite covers hybrid and fallback paths.
- Latency budget checks are measurable and documented.
- Rollout strategy supports staged enablement and rollback.

## Dependencies
063
064
065
035
033

## Deliverables
- Test matrix updates and implementation.
- Rollout + guardrail documentation and checks.

## Estimate
M

## Priority
Medium

---

## Implementation Plan

### Implemented Hybrid Search Guardrails + Reliability Test Coverage (Phase: Plan + Code)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Defined guardrail surfaces (rollout toggle, budget, fallback)
	- Defined reliability test matrix for hybrid/fallback correctness
- ✅ Phase 2 (Implementation): Complete in this ticket
	- Added runtime rollout controls in `MarkdownDocumentReader`
	- Added latency budget enforcement with lexical fallback
	- Added dedicated tests for missing-index fallback and latency fallback
- ⏳ Deferred
	- Deep observability event catalog integration (future reliability refinement)

#### Background
Hybrid retrieval introduces failure modes not present in scan-only behavior. This ticket adds safeguards and tests so hybrid can be enabled progressively without risking query regressions.

#### Approach
Implemented rollout controls as configuration knobs and enforced a max hybrid processing budget per query. If hybrid exceeds budget or cannot execute, reader logs a warning and falls back to lexical path. Test coverage now validates hybrid success, missing-index fallback, and latency-budget fallback.

#### Examples / Specifications
Guardrail controls:
- `KB_HYBRID_QUERY` enable/disable hybrid path
- `KB_HYBRID_QUERY_MAX_MS` per-query hybrid budget
- `KB_HYBRID_QUERY_CANDIDATES` FTS candidate cap
- `KB_HYBRID_QUERY_ALPHA` lexical/vector weighting

Fallback/guardrail behavior:
- Hybrid unavailable (DB missing, SQL errors): `read_documents` still returns lexical matches.
- Hybrid over budget: warning emitted and lexical path used.
- Caller receives stable `QueryResponse` either way.

#### Error Conditions / Edge Cases
- Zero/invalid config values: defaults are applied.
- Missing embeddings per chunk: fallback scoring still produces deterministic ranking.
- Include-content reads fail on indexed file path: fallback to chunk-level content snippet.

#### Decisions Made
- ✅ Decided: Guardrail fallback is reliability-first (prefer lexical success over hybrid strictness). -> Rationale: protects end-user query availability.
- ✅ Decided: Budget applies to hybrid phase only. -> Rationale: isolates risk while preserving existing lexical behavior.
- ✅ Decided: Observability starts with warning logs in this phase. -> Rationale: minimal integration cost while enabling diagnosis.

#### Integration Points
- Extends ticket 065 runtime with reliability controls.
- Aligns with ticket 035 quality/test-matrix expectations.
- Provides operational safety baseline ahead of broader rollout.

#### Validation & Closure
This implementation establishes:
- ✅ Acceptance criterion met: test suite now covers hybrid and fallback paths.
- ✅ Acceptance criterion met: latency budget checks are implemented and testable.
- ✅ Acceptance criterion met: rollout strategy supports staged enablement with env/options controls.

Test evidence:
- `tests/tools/markdown-document-reader.test.ts`
	- hybrid enabled ranking path
	- missing SQLite fallback path
	- low-latency budget fallback path

**Ticket 066 is now closed.**
