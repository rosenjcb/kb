# Implement retrieval miss-learning schema and feedback loop

## Ticket ID
073

## Theme
intelligence

## Problem
Misses and low-confidence retrieval outcomes are not captured in a structured way, preventing systematic improvement over time.

## Scope
- Implement miss-learning persistence schema.
- Capture miss reason/fingerprint and replay metadata.
- Add safe ranking-hint feedback loop for repeated patterns.

## Acceptance Criteria
- Miss events are persisted with deterministic schema.
- Ranking hints are read-only/guarded by rollout flag.
- Replay tooling can inspect miss clusters.

## Dependencies
071
072
064

## Deliverables
- Schema migration + read/write runtime paths.
- Tests for miss capture and hint application guardrails.

## Estimate
M

## Priority
High
