# Specify fact validation and dispute contract

## Ticket ID
056

## Theme
intelligence

## Problem

Consumers need high-level truth workflows: validate fact, dispute fact, and receive why/why-not explanations. Today this behavior is implicit and not contract-defined.

## Scope
- Define `validate_fact` consumer intent contract.
- Define `dispute_fact` consumer intent contract.
- Define response statuses: valid | invalid | uncertain.
- Define required explanation/provenance fields.
- Define follow-up action recommendations when invalid/uncertain.

## Acceptance Criteria
- Validation/dispute schemas are explicit and testable.
- Status semantics are unambiguous.
- Provenance fields are required in responses.
- Error and uncertainty handling are specified.
- Examples cover CLI and agent client usage.

## Dependencies
003,005,027,028,046,054

## Deliverables
- Full contract spec with sample payloads.
- Decision table for status assignment.
- Integration notes for check/deep_validation flows.

## Estimate
M

## Priority
HIGH
