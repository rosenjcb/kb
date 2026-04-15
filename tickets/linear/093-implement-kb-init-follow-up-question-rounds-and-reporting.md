# Implement `kb init` follow-up question rounds and coverage reporting

## Ticket ID
093

## Theme
onboarding / cli-ux / reporting

## Problem

Ticket 090 defines interactive follow-up rounds, topic-specific sub-questions, and explicit final coverage reporting, but the current `kb init` CLI only asks one initial batch of questions and does not expose unresolved or inference-only areas in its final output.

## Scope

- Implement topic-targeted follow-up question rounds in interactive mode
- Support bounded sub-questions for weak or contradictory topics
- Add explicit unresolved / inferred topic summaries to final init output
- Ensure non-interactive mode reports uncertainty rather than hiding it

## Acceptance Criteria

- Interactive `kb init` can ask targeted follow-ups after draft synthesis
- Topic-level sub-questions are bounded by configured budgets
- Final output reports covered, inferred, and unresolved topics
- Tests cover interactive follow-up flow and non-interactive reporting

## Dependencies

- 090
- 091
- 092

## Deliverables

- Follow-up question runtime in `kb init`
- Final coverage reporting surface
- Tests for interactive/non-interactive reporting behavior

## Estimate
L

## Priority
High
