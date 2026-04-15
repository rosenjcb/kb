# Implement `kb config` runtime and shared config service

## Ticket ID
084

## Theme
local-kb / cli-config

## Problem

Ticket 083 defines the unified durable config contract, but the runtime does not yet provide a shared config service or the `kb config` command family needed to read and write that schema consistently.

## Scope
- Implement a shared config read/write module for `~/.kb/config.json`.
- Implement `kb config get`, `kb config get <key>`, `kb config set <key> <value>`, and `kb config unset <key>`.
- Enforce the allowlisted key-path contract from ticket 083.
- Automatically manage `updatedAt` on persisted writes.
- Remove `sessionBase` from persisted output on any config rewrite.
- Keep `updatedAt` read-only from the CLI surface.

## Acceptance Criteria
- Users can inspect the entire config and supported nested keys via `kb config`.
- Writes follow the ticket 083 schema and validation rules.
- Invalid or read-only key writes return explicit non-zero errors.
- Config rewrites normalize away deprecated `sessionBase`.
- Tests cover full-object reads, scalar reads, nested writes, nested unsets, and invalid-key behavior.

## Dependencies
083

## Deliverables
- Shared config module under `src/cli/` or adjacent shared runtime location.
- CLI parser wiring for the `kb config` command family.
- Automated tests for config read/write behavior and normalization.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Shared `kb config` Runtime With Normalized Durable Schema

#### Background
Ticket 083 defined `kb config` as the authoritative durable configuration surface, but the runtime still lacked a shared config service and command handlers for reading and writing that schema. Without this implementation, config behavior would remain split between base-selection helpers and publish-specific readers.

#### Approach
Add a shared config service in `src/cli/kb-config.ts` that owns reading, normalizing, validating, and writing `~/.kb/config.json`, then add a dedicated `src/cli/config-cli.ts` module for `get`, `set`, and `unset` command execution. Keep the v1 key surface intentionally small and allowlisted (`defaultBase`, `notion.*`, `updatedAt`) so nested config writes are explicit rather than arbitrary JSON mutation. Normalize persisted config on every write by dropping deprecated `sessionBase`, pruning empty nested objects, and updating `updatedAt` automatically. Reuse the shared config reader in publish flows so Notion settings stop depending on a separate private parser.

#### Examples / Specifications
Implemented modules:

```text
src/cli/kb-config.ts
- readKbConfig()
- writeKbConfig()
- getConfigValue()
- setConfigValue()
- unsetConfigValue()
- resolveNotionToken()

src/cli/config-cli.ts
- runConfigCommand()
- printConfigHelp()
```

Supported runtime commands:

```bash
kb config get
kb config get defaultBase
kb config get notion.parentPageId
kb config set defaultBase dogfood
kb config set notion.parentPageId 123abc
kb config unset notion.parentPageId
```

Normalization behavior:

```json
{
  "defaultBase": "dogfood",
  "notion": {
    "token": "secret",
    "parentPageId": "123abc"
  },
  "updatedAt": "2026-04-15T05:37:52.777Z"
}
```

If legacy persisted state contains:

```json
{
  "sessionBase": "old-session",
  "defaultBase": "dogfood"
}
```

Any `kb config set` or `kb config unset` rewrite produces:

```json
{
  "defaultBase": "dogfood",
  "updatedAt": "..."
}
```

#### Error Conditions / Edge Cases
- Unknown keys return `UNKNOWN_CONFIG_KEY` with the allowlisted key set.
- `updatedAt` is treated as read-only and returns `READ_ONLY_CONFIG_KEY` on write or unset attempts.
- `kb config get <key>` on a supported but missing value returns `CONFIG_VALUE_NOT_SET`.
- `kb config set notion <value>` is rejected because object writes must use nested keys.
- Unsetting the last Notion field removes the empty `notion` object from persisted config.
- The real `~/.kb/config.json` write path may require host-level permission in sandboxed environments; tests use a temp config file override.

#### Decisions Made
- ✅ Decided: Keep `kb config` command parsing in a dedicated module rather than embedding the behavior in `index.ts`. -> Rationale: makes the command surface directly testable without shelling the full CLI.
- ✅ Decided: Normalize persisted config on every write. -> Rationale: this is the safest place to remove deprecated `sessionBase` and prune empty nested objects.
- ✅ Decided: Reuse the shared config reader in `publish-cli.ts`. -> Rationale: avoids another config parser drifting from the contract.
- ✅ Decided: Limit v1 writes to scalar leaf keys plus `unset notion`. -> Rationale: simpler validation and less risk than arbitrary object replacement.

#### Integration Points
- Implements the runtime half of ticket 083.
- Leaves ticket 085 to migrate `kb use`, `kb default`, and broader consumer behavior to the new durable-vs-ephemeral model.
- Updates publish-time Notion config reading to consume the shared service now, reducing duplicate config logic immediately.

#### Validation & Closure
This implementation establishes:
- ✅ Shared config service for normalized read/write behavior in `~/.kb/config.json`.
- ✅ Working `kb config get/set/unset` runtime with allowlisted nested keys.
- ✅ Automated tests covering full-config reads, nested Notion writes, legacy `sessionBase` cleanup, and invalid key behavior.
- ✅ Type-safe integration with the existing CLI and publish config consumer.

**Ticket 084 is now closed.**
