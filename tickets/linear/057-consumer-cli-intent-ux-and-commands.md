# Specify consumer CLI intent UX and command set

## Ticket ID
057

## Theme
local-kb

## Problem

CLI should present intent-level commands (submit, validate, dispute, query, explain) instead of exposing low-level operation language.

## Scope
- Define intent-first CLI commands and argument conventions.
- Define natural language prompts + structured JSON modes.
- Define output formats for humans and agents.
- Define migration path from current tool-centric prompts.

## Acceptance Criteria
- CLI command vocabulary frozen for v1.
- Examples provided for each intent command.
- Human-readable and machine-readable output modes specified.
- Backward compatibility/migration behavior documented.
- Internal tool names are absent from consumer docs/help output.

## Dependencies
012,013,054,055,056

## Deliverables
- CLI UX spec and command reference.
- Prompt examples and output examples.
- Migration/deprecation note for old command style.

## Estimate
M

## Priority
HIGH

---

## Implementation Plan

### Intent-First CLI Command Set v1

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Intent command vocabulary frozen
	- Output modes and examples specified
	- Migration path from tool-centric prompts defined
- ⏳ Phase 2 (Implementation): Deferred
	- CLI command implementation deferred to tickets 058 and 059

#### Background
CLI currently encourages low-level tool phrasing. Consumers should use intent commands independent of internal operation details.

#### Approach
Define explicit intent commands and a consistent output envelope supporting two modes: `human` and `json`. Hide internal tool names from CLI help and public docs.

#### Examples / Specifications
Command set:

```text
kb submit "<fact>" [--domain ops] [--source runbook]
kb validate "<fact>" [--domain ops]
kb dispute "<fact>" --because "<counter evidence>"
kb query "<topic>" [--limit 5]
kb explain "<change id|fact>"
```

Machine mode:

```text
kb validate "Deployments require feature flag X" --output json
```

JSON output example:

```json
{
	"intent": "validate_fact",
	"status": "uncertain",
	"confidence": 0.52,
	"explanation": "Conflicting runbook and incident notes.",
	"recommendedAction": "dispute_fact"
}
```

Human output example:

```text
Status: uncertain (confidence 0.52)
Why: Conflicting runbook and incident notes.
Next: Submit dispute with latest evidence.
```

Migration/deprecation:
- Old style: prompts mentioning `write_document`, `append_to_document` in user-facing docs.
- New style: intent commands only.
- Internal tools remain available only behind router.

#### Error Conditions / Edge Cases
- Unknown command → show intent command help and exit non-zero.
- Missing required argument (`--because` for dispute) → validation error with example.
- JSON mode with non-serializable result → fallback to structured error JSON.

#### Decisions Made
- ✅ Decided: Five command verbs map to five public intents.
	- Rationale: 1:1 conceptual model for users.
- ✅ Decided: Dual output mode (`human`, `json`).
	- Rationale: Supports both people and agents.
- ✅ Decided: No internal tool names in `--help` or consumer docs.
	- Rationale: Maintain boundary contract.
- ✅ Decided: Migration is additive first, then deprecate old examples.
	- Rationale: Reduce disruption.

#### Integration Points
- Ticket 054 provides consumer intent contract.
- Ticket 055 defines router layer invoked by CLI.
- Ticket 056 defines validate/dispute response semantics.
- Ticket 059 implements CLI command handlers.

#### Validation & Closure
This implementation plan establishes:
- ✅ CLI intent vocabulary frozen for v1.
- ✅ Human/JSON output contracts documented.
- ✅ Migration path from tool-centric language defined.
- ✅ Consumer docs/help boundary requirements specified.

**Ticket 057 is now closed.**

