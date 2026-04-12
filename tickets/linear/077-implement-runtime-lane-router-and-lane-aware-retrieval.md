# Implement runtime lane router and lane-aware retrieval pipeline

## Ticket ID
077

## Theme
intelligence

## Problem
Without lane-aware routing, mixed-category retrieval still allows low-relevance sources to outrank fact-focused evidence.

## Scope
- Add runtime lane router from query intent/evidence signals.
- Restrict candidate retrieval set by selected lanes before hybrid/vector scoring.
- Keep title influence low and rank primarily by lane fitness and evidence quality.

## Acceptance Criteria
- Reader can execute lane-filtered retrieval per request.
- Broad project queries and operational error queries route to different lane sets.
- Tests validate lane routing and ranking outcomes.

## Dependencies
075
076
072

## Deliverables
- Lane router module + reader integration.
- Tests for lane selection and lane-aware ranking behavior.

## Estimate
M

## Priority
High
