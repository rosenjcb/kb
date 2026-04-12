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

---

## Implementation Summary

### Outcome
Implemented intent-first CLI command handling with human/json output modes and router-based execution.

### Delivered
- Added CLI intent command runtime: `src/cli/intent-cli.ts`
	- Commands: `submit`, `validate`, `dispute`, `query`, `explain`
	- Parsing for options (`--domain`, `--source`, `--because`, `--limit`, `--type`, `--output`)
	- Output modes: `human` and `json`
	- Command help rendering
- Wired intent command fast-path into `src/cli/index.ts`
	- Intent commands bypass LLM loop and execute through router
	- Existing freeform query behavior remains available
- Added CLI intent tests: `tests/cli/intent-cli.test.ts`

### Validation
- Type-check passes.
- Unit tests pass including new CLI intent coverage.

### Integration Notes
- CLI commands map to ticket 054 intent contract through router (ticket 058).
- Internal tool names are not required for consumer command usage.

**Ticket 059 is now closed.**

