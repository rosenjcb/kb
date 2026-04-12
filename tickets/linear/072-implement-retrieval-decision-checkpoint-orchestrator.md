# Implement retrieval decision-checkpoint orchestrator across read_documents consumers

## Ticket ID
072

## Theme
intelligence

## Problem
Retrieval paths currently vary by surface and do not consistently execute a deterministic escalation sequence when evidence quality is low.

## Scope
- Implement a shared retrieval orchestrator for `read_documents` consumers.
- Encode checkpoint stages and stop/go criteria.
- Expose retrieval-attempt trace metadata in outputs.

## Acceptance Criteria
- Shared orchestrator executes deterministic stage ordering.
- Stop/go criteria are unit-tested.
- Chat and intent flows can consume the same orchestrator output contract.

## Dependencies
071
065
068

## Deliverables
- Orchestrator module + integration hooks.
- Tests for stage transitions and fallback conditions.

## Estimate
M

## Priority
High
