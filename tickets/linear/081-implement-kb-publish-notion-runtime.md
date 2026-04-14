# Implement `kb publish` Notion runtime

## Ticket ID
081

## Theme
notion

## Problem
Ticket 080 finalized the SPIKE plan and defaults for Notion publishing, but the runtime does not yet exist. We need a working `kb publish` command that performs package/import orchestration and outputs operator-ready AI prompts.

## Scope
- Implement top-level `kb publish` command in CLI.
- Implement phase orchestration: `package`, `import`, `restructure`, `all`.
- Add Notion provider runtime (v1 default provider).
- Read Notion credentials from existing local config (`~/.kb/config.json`) with env fallback.
- Produce deterministic artifact metadata and operator prompt payload.
- Keep a single publish command surface in v1.

## Acceptance Criteria
- `kb publish --base <base> --dry-run` returns deterministic plan without mutating Notion.
- `kb publish --base <base> --apply` performs package + import and emits restructure prompt instructions.
- `kb publish --phase package|import|restructure|all` behaves deterministically and validates required inputs.
- Zip artifact excludes binary index files and includes `manifest.json` with checksum and file counts.
- Import creates/uses Archive staging target and returns destination page id/url.
- Restructure phase outputs prompt pack and target-page context for operator execution in Notion AI.
- Tests cover CLI parsing, failure modes, and provider runtime contract.

## Dependencies
080
022
023
026
043

## Deliverables
- CLI command wiring in `src/cli/index.ts`.
- Provider/runtime modules under `src/tools/` or `src/core/` as appropriate.
- Test coverage in `tests/cli/` and provider/runtime tests.
- Operator usage docs update in README or CLI help output.

## Estimate
L

## Priority
High
