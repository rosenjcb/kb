# Wire specialized tools into registry and complete test matrix

## Ticket ID
053

## Theme
local-kb

## Problem

Even with individual tool implementations, we need consistent registration, exposure to providers, and full test coverage matrix across tool contracts.

## Scope
- Register 048–052 tools in `kb-tools-registry`.
- Ensure tool schemas are exposed to provider loop.
- Add/update tool-executor and integration behavior as needed.
- Build descriptive scenario test matrix for create/append/update/merge/prune.

## Acceptance Criteria
- All specialized tools are registered and invokable.
- Registry/type-check passes cleanly.
- Tool executor handles new tools and errors consistently.
- Test matrix includes descriptive scenarios (not just command names).
- Full test suite passes.

## Dependencies
004,009,035,047,048,049,050,051,052

## Deliverables
- registry wiring + executor updates.
- scenario-based tests and verification notes.
- final integration checklist for ticket 047 Phase 2 completion.

## Estimate
M

## Priority
HIGH
