# Add lane-routing evaluation fixtures and rollout guardrails

## Ticket ID
078

## Theme
reliability

## Problem
Lane-aware retrieval requires measurable precision gains and controlled rollout to avoid regressions.

## Scope
- Add before/after evaluation fixtures comparing mixed-lane vs lane-routed retrieval.
- Define lane-routing promotion/rollback thresholds.
- Extend observability outputs for lane effectiveness metrics.

## Acceptance Criteria
- Evaluation fixtures are executable and produce comparable metrics.
- Guardrail thresholds and decision outcomes are explicit.
- Observability includes lane-level precision/fallback indicators.

## Dependencies
075
077
074

## Deliverables
- Evaluation fixtures + metric report shape.
- Rollout guardrail documentation and tests.

## Estimate
M

## Priority
Medium
