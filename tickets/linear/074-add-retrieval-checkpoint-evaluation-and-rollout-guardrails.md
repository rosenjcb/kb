# Add retrieval checkpoint evaluation and rollout guardrails

## Ticket ID
074

## Theme
reliability

## Problem
Retrieval improvements need measurable quality validation and controlled rollout to avoid precision regressions.

## Scope
- Add evaluation scenarios for checkpoint and miss-learning behavior.
- Define quality thresholds and rollback conditions.
- Add rollout controls and observability for decision-stage effectiveness.

## Acceptance Criteria
- Before/after evaluation scenarios are executable and documented.
- Thresholds for promotion/rollback are explicit.
- Observability includes per-stage success/fallback rates.

## Dependencies
071
072
073
066

## Deliverables
- Evaluation plan + test fixtures.
- Rollout and guardrail documentation.

## Estimate
M

## Priority
Medium

---

## Implementation Notes

### Delivered Runtime
- Added checkpoint observability persistence via `retrieval_checkpoint_events` in the SQLite index schema.
- Added stage metrics query for per-stage success/fallback tracking.
- Added rollout guardrail evaluator returning deterministic decisions: `promote`, `hold`, `rollback`.

### Default Rollout Thresholds
- `minSampleSize = 20`
- `minOverallSuccessRate = 0.70`
- `maxOverallMissRate = 0.25`
- `maxHybridFallbackRate = 0.50`

### Evaluation Scenarios (Executable)
- Stage metrics and guardrail promotion/rollback scenarios are covered in `tests/tools/sqlite-kb-index.test.ts`.
- Reader-side checkpoint persistence path is covered in `tests/tools/markdown-document-reader.test.ts`.

### Rollout Controls
- Reader checkpoint event persistence is controlled by `KB_CHECKPOINT_OBSERVABILITY_ENABLED` (enabled by default; set to `false` to disable).
- Ranking hint serving remains separately gated behind `KB_MISS_HINTS_ENABLED`.

### Validation & Closure
This implementation delivers:
- ✅ Executable evaluation scenarios for checkpoint/miss-learning behavior.
- ✅ Explicit promotion/rollback thresholds and deterministic decision logic.
- ✅ Stage-level observability metrics for success/fallback rates.

**Ticket 074 implementation is complete.**
