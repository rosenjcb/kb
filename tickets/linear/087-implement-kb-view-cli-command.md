# Implement `kb docs` CLI command family

## Ticket ID
087

## Theme
local-kb / cli-ux

## Problem

Ticket 086 defines the `kb docs` browsing contract, but the runtime does not yet exist. Users still cannot list available documents or open a full document directly from the CLI after discovery.


- Add `kb docs list` and `kb docs view` argument parsing and help text to the CLI.
- Implement exact document ID lookup and `--title` lookup using the shared reader.
- Implement metadata-only listing with a simple `--limit` flag.
- Render human-readable stdout output for a single document.
- Add `--output json` support for machine-readable document output.
- Implement exit/error behavior for missing, ambiguous, and invalid invocations.
- Add focused tests for parser behavior, output format, and error handling.
- **Note:** The canonical CLI contract is now `kb docs list` and `kb docs view`. Do not reference legacy `kb view` or `kb invalidate` commands. `kb explain` is valid.

## Acceptance Criteria

- `kb docs list` prints a browsable document list.
- `kb docs view <document-id>` prints the full document to stdout.
- `kb docs view --title "<title>"` resolves exact title matches.
- `kb docs view --output json` emits one full document payload.
- Not-found and ambiguous lookups fail with documented exit behavior.
- Help text and examples mention `kb docs`.

## Dependencies

086

## Deliverables

- CLI runtime for `kb docs`
- Output formatter(s)
- Test coverage for view behavior

## Estimate
M

## Priority
High
