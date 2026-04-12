# Validate kb chat mode and harden context-rot handling

## Ticket ID
070

## Theme
reliability

## Problem
Prompt/system-driven chat loops can degrade over long sessions without explicit context-rot controls.

## Scope
- Add validation suite for chat mode quality and regressions.
- Measure and enforce bounded context trimming strategy.
- Define context-rot mitigation follow-ups from real usage telemetry.

## Acceptance Criteria
- Automated tests cover long-session behavior and context trimming.
- Retrieval grounding remains stable across extended conversations.
- Mitigation strategy and thresholds are documented.

## Dependencies
067
068
069
035
033

## Deliverables
- Test scenarios + guardrail checks.
- Context-rot mitigation documentation and thresholds.

## Estimate
M

## Priority
Medium
