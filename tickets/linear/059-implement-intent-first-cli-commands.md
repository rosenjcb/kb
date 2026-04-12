# Implement intent-first CLI commands

## Ticket ID
059

## Theme
local-kb

## Problem

Ticket 057 defines command UX, but CLI still does not expose finalized intent verbs with output modes.

## Scope
- Add `submit|validate|dispute|query|explain` commands.
- Add `--output human|json` behavior.
- Route command intents through IntentRouter.
- Update CLI help text to remove internal tool vocabulary.

## Acceptance Criteria
- All five commands are callable and documented in `--help`.
- Human and JSON outputs conform to spec.
- Invalid command/payload errors are descriptive.
- Backward compatibility path documented.

## Dependencies
057,058,054

## Deliverables
- CLI command handlers and parser updates.
- Output formatting layer.
- CLI tests for success/error cases.

## Estimate
M

## Priority
HIGH
