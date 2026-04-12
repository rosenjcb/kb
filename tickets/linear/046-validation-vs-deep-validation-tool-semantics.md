# Define validation vs deep_validation tool semantics

## Ticket ID
046

## Theme
intelligence

## Problem
We need two distinct validation modes with different intent and execution depth so users and agents can choose the right verification path.

## Scope
- Define validation as statement verification against existing knowledge base documents.
- Define deep_validation as conformance verification against real source artifacts in the repository.
- Specify request and response shape for both modes.
- Define confidence scoring and evidence requirements for both modes.
- Define fallback behavior when KB docs are missing or stale.
- Define requester guidance output so the agent can tell Claude (or any requester) exactly what to do next.

## Acceptance Criteria
- The semantic difference between validation and deep_validation is explicit and testable.
- validation examples include KB-first questions, for example: Is our UI divided into admin and user sections?
- deep_validation examples include code-conformance checks, for example: Tables are snake_case in prisma schema.
- Output contracts include status, evidence, confidence, rationale, and requester_actions fields.
- Escalation rules are defined, including when validation should recommend deep_validation.
- requester_actions includes concrete next steps such as files to inspect, updates to make, and verification commands to run.

## Dependencies
003,018,019,027

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Notes
- This ticket enforces a closed-loop pattern: detect mismatch -> explain mismatch -> instruct requester on next action.

## Estimate
M

## Priority
TBD