# Migrate base selection and publish flows to unified config model

## Ticket ID
085

## Theme
local-kb / cli-config

## Problem

Even after `kb config` exists, older consumers will still read or write configuration through fragmented code paths unless they are migrated to the unified model from ticket 083.

## Scope
- Update `kb default` to use the shared durable config service.
- Update `kb use` to stop persisting `sessionBase` and behave as an ephemeral session helper.
- Update base-resolution helpers and tests to remove persisted `sessionBase` assumptions.
- Update `kb publish` to consume Notion settings through the shared config service rather than a private config reader.
- Refresh help text and user guidance so config precedence and command intent stay consistent.

## Acceptance Criteria
- `kb default` and `kb config set defaultBase` write the same persisted state.
- `kb use` no longer stores `sessionBase` in `~/.kb/config.json`.
- Publish-time Notion config reads use the shared config model from ticket 084.
- Tests reflect the new durable-vs-ephemeral behavior for base selection.
- CLI help text is consistent with the unified config contract.

## Dependencies
083, 084

## Deliverables
- Updated base-selection runtime and tests.
- Updated publish config consumer integration.
- CLI help and migration messaging aligned with the unified config model.

## Estimate
M

## Priority
High
