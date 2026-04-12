# Add chat session controls and transcript persistence

## Ticket ID
069

## Theme
local-kb

## Problem
An interactive chat mode requires operational controls and persisted transcripts for continuity.

## Scope
- Implement chat slash commands (`/help`, `/reset`, `/save`, `/exit`).
- Persist chat transcripts to session storage with namespace-aware paths.
- Define autosave/checkpoint behavior.

## Acceptance Criteria
- Slash commands are documented and functional.
- Transcript files are persisted and recoverable.
- Session reset and save semantics are deterministic.

## Dependencies
067
068
010

## Deliverables
- Command handlers and transcript writer.
- Tests for control and persistence behavior.

## Estimate
M

## Priority
High
