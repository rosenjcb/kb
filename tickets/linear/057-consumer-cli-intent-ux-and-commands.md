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
