# Define unified `kb config` CLI and config schema

## Ticket ID
083

## Theme
local-kb / cli-config

## Problem

KB configuration is currently split across multiple surfaces with overlapping semantics:

1. Base selection is managed through `kb use` / `kb default` and persisted in `~/.kb/config.json`.
2. The persisted schema contains both `defaultBase` and `sessionBase`, but it is unclear whether both concepts are still necessary or whether they are acting as two names for the same user intent.
3. Notion publishing reads separate config fields from the same config file, but there is no first-class CLI for inspecting or updating that config safely.
4. Users cannot consistently ask the CLI for current configuration state (for example, full config vs one key) or update individual keys through a stable command contract.

This makes configuration harder to understand, harder to automate, and harder to evolve safely as KB grows beyond base selection into provider-specific settings such as Notion.

## Scope

- Define a single user-facing configuration command family rooted at `kb config`.
- Specify the command contract for:
  - `kb config get`
  - `kb config get <key>`
  - `kb config set <key> <value>`
  - `kb config unset <key>`
  - optional discovery helpers such as `kb config list` or `kb config keys` if justified by the design
- Decide whether `sessionBase` remains a real persisted concept or is removed in favor of `defaultBase` only.
- Define the persisted config schema for current known settings:
  - `defaultBase`
  - `updatedAt`
  - Notion configuration fields currently used by publish flows
- Define key-path behavior for nested config access (for example `notion.parentPageId`).
- Define read/write behavior for full-config output vs single-key output, including human-readable and machine-readable expectations.
- Define migration behavior from the current config shape to the new contract.
- Clarify the relationship between `kb use`, `kb default`, env vars, and `kb config` once the unified config surface exists.

## Acceptance Criteria

- A clear CLI contract exists for reading, writing, unsetting, and inspecting KB config values.
- The persisted config schema is explicitly documented, including supported top-level and nested keys.
- The design makes an explicit decision on `sessionBase` vs `defaultBase` and explains migration behavior.
- Interoperability rules between `kb use`, `kb default`, env vars, and `kb config` are unambiguous.
- Error behavior is specified for unknown keys, missing values, invalid nested paths, and unset required config.
- The ticket identifies follow-up implementation and validation work needed to ship the config CLI.

## Dependencies

006, 062, 081, 082

## Deliverables

- Ticket-level spec for the unified `kb config` command family.
- Proposed persisted config schema and compatibility rules.
- Decision on whether `sessionBase` survives, is renamed, or is removed.
- Initial migration and rollout notes for existing `~/.kb/config.json` users.
- Follow-up implementation checklist for CLI wiring, tests, and config consumers such as `kb publish`.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Unified `kb config` Contract and Persistent Schema

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
  - Unified `kb config` command contract
  - Persisted config schema and supported key paths
  - Decision on `sessionBase` vs `defaultBase`
  - Migration and interoperability rules
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
  - 084: shared config service + `kb config` runtime
  - 085: migrate `kb use`, `kb default`, and `kb publish` consumers to the unified model

#### Background
KB currently persists user configuration in `~/.kb/config.json`, but the contract is fragmented across base-selection helpers and publish-specific config readers. The resulting schema mixes durable settings (`defaultBase`, Notion fields) with `sessionBase`, which behaves like a persisted override even though its name implies a temporary scope.

#### Approach
Make `kb config` the single durable configuration surface and reduce the persisted schema to stable, user-owned settings only. Persist `defaultBase`, `updatedAt`, and current Notion fields in `~/.kb/config.json`, remove `sessionBase` from disk, and treat `kb use` as an ephemeral session helper that does not mutate durable state. Use an allowlisted dot-path model for nested keys so `kb config get notion.parentPageId` and `kb config set notion.parentPageId <value>` are explicit and safe. Keep provider-specific environment variables for secrets and runtime integration, but remove environment-variable base selection as a supported surface.

#### Examples / Specifications
Command surface:

```bash
kb config get
kb config get defaultBase
kb config get notion.parentPageId

kb config set defaultBase dogfood
kb config set notion.parentPageId 123abc
kb config set notion.token secret-token

kb config unset defaultBase
kb config unset notion.parentPageId
```

Persisted schema:

```ts
interface KbConfig {
  defaultBase?: string
  notion?: {
    token?: string
    parentPageId?: string
  }
  updatedAt: string
}
```

Supported key paths in v1:

```text
defaultBase
notion
notion.token
notion.parentPageId
updatedAt   (read-only; system-managed)
```

Output contract:

```text
kb config get
=> pretty JSON object for the entire config

kb config get defaultBase
=> raw scalar value followed by newline

kb config get notion
=> pretty JSON object for the nested object

kb config get missing.key
=> non-zero exit with UNKNOWN_CONFIG_KEY
```

Interoperability model:

```text
Durable configuration:
- kb config set defaultBase <base>
- kb default <base> becomes a compatibility wrapper around the same write path

Ephemeral session selection:
- kb use <base> does not persist config.json
- kb use <base> remains a non-durable helper separate from persisted config

Runtime precedence:
1) explicit command flag/input (for example --base)
2) persisted kb config (defaultBase, notion.*)
3) provider-specific env vars where applicable
4) command-specific fallback/error
```

Migration behavior:

```text
If config.json contains sessionBase:
- treat it as deprecated persisted state
- on first config write, drop sessionBase from the saved file
- defaultBase remains the only persisted base selector
```

#### Error Conditions / Edge Cases
- Unknown key path -> return `UNKNOWN_CONFIG_KEY` with the supported key list.
- Attempt to write `updatedAt` directly -> return `READ_ONLY_CONFIG_KEY`.
- `kb config set` without a value -> return usage help and non-zero exit.
- `kb config unset notion` when nested values exist -> remove the whole nested object intentionally.
- Removing the last nested Notion key -> collapse empty `notion` object from persisted output.
- `kb use <base>` must not silently create durable config changes.
- Provider env vars may still override secrets/config for their own surfaces, but base selection no longer has an env fallback.

#### Decisions Made
- ✅ Decided: `kb config` becomes the authoritative durable config interface. -> Rationale: one command family is easier to document, test, and extend than multiple ad hoc setters.
- ✅ Decided: Remove `sessionBase` from the persisted schema. -> Rationale: it duplicates `defaultBase` semantics in practice and creates confusion about session vs durable scope.
- ✅ Decided: Keep `defaultBase` as the only persisted base selector. -> Rationale: it matches the user mental model for a saved default and aligns with existing `kb default`.
- ✅ Decided: Keep `kb use` as an ephemeral compatibility helper, not a config writer. -> Rationale: the command name implies temporary scope and should not mutate durable state.
- ✅ Decided: Use allowlisted dot-path keys for nested config access. -> Rationale: it supports Notion fields without exposing arbitrary JSON mutation.
- ✅ Decided: Keep `updatedAt` and manage it automatically on every persisted write. -> Rationale: change tracking is useful, but callers should not be able to corrupt it manually.
- ✅ Decided: Keep Notion credentials in the current config file model for now. -> Rationale: this ticket unifies the contract first; secret-store hardening can be a separate future concern.

#### Integration Points
- Supersedes the persisted-schema portion of ticket 062 by replacing `sessionBase` persistence with `defaultBase`-only durability.
- Provides the shared config contract needed by ticket 081 publish flows, which already read `notion.token` and `notion.parentPageId`.
- Aligns with ticket 006 by clarifying that env vars are runtime overrides rather than the primary local configuration surface.
- Implemented by:
  - 084: shared config service and `kb config` command runtime
  - 085: consumer migration for `kb use`, `kb default`, `kb publish`, and related tests

#### Validation & Closure
This implementation plan establishes:
- ✅ A reviewable command contract for `kb config get/set/unset`.
- ✅ A concrete persisted schema with supported key paths and migration behavior.
- ✅ A resolved decision on `sessionBase` vs `defaultBase`.
- ✅ Clear interoperability rules for `kb use`, `kb default`, and publish-time Notion config.
- ✅ Explicit follow-up tickets for deferred runtime implementation work.

**Ticket 083 is now closed.**
