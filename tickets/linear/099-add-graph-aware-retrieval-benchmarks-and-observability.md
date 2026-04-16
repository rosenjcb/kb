# Add Graph-Aware Retrieval Benchmarks and Observability

## Ticket ID
099

## Theme
Retrieval quality

## Problem
We need a repeatable way to measure whether graph-aware ranking is actually improving retrieval quality and not just changing rankings.

## Scope
- Add benchmark fixtures and evaluation questions
- Add graph score breakdown logging or debug output
- Define tuning thresholds for graph boost weights

## Acceptance Criteria
- A repeatable benchmark script or test fixture exists
- Retrieval observability can show graph contribution to ranking
- Tuning guidance exists for enabling, disabling, or reducing graph weight

## Dependencies
- 097
- 098

## Deliverables
- Benchmark coverage
- Observability support
- KB checkpoint

## Estimate
M

## Priority
High
