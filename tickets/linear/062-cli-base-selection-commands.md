# Add CLI base-selection commands for KB context

## Ticket ID
062

## Theme
local-kb

## Problem

Users currently rely on environment variables (`KB_BASE_DIR`) and shell state to choose KB storage context. This is friction-heavy and easy to misconfigure across sessions.

## Scope
- Define user-facing commands to select active KB base context.
- Introduce two commands inspired by nvm-style ergonomics:
  - `kb use <base>`: one-off/session-scoped context switch.
  - `kb default <base>`: persist preferred base for future invocations.
- Define precedence between CLI selection, env vars, and defaults.
- Define how named bases map to concrete storage directories.

## Acceptance Criteria
- CLI contract for `use` and `default` is documented with examples.
- Resolution order is explicit and deterministic.
- Error behavior is specified for unknown/invalid bases.
- Backward compatibility with existing `KB_BASE_DIR` flows is preserved.

## Dependencies
006,010,038,057

## Deliverables
- Ticket-level command contract and precedence rules.
- Storage mapping strategy for named bases.
- Follow-up implementation and test checklist.

## Estimate
M

## Priority
HIGH

---

## Implementation Plan

### CLI Base Selection Model (`kb use` + `kb default`)

#### Background
The current configuration model depends on process-level environment variables, which is reliable for automation but awkward for day-to-day interactive usage. We need an nvm-like experience where users can quickly switch KB context and persist a preferred default.

#### Approach
Add two intent-first CLI utility commands that manage a lightweight base-selection config while preserving explicit path override behavior. `kb use <base>` resolves and applies a base context for the current shell session by printing export instructions, and `kb default <base>` updates persisted user-level defaults for future invocations. Runtime storage resolution remains deterministic through a strict precedence order: explicit path override -> base alias env -> persisted default -> existing built-in fallback.

#### Examples / Specifications
```bash
# Set session context (non-persistent)
kb use dogfood

# Persist preferred context
kb default dogfood

# Optional utility visibility
kb use --show
kb default --show
```

```text
Resolution precedence (highest to lowest):
1) explicit runtime override (future: --base)
2) KB_BASE_DIR (if set)
3) KB_BASE (if set)
4) persisted default from ~/.kb/config.json
5) fallback: <repo>/sessions/namespaces/default/documents
```

```json
{
  "defaultBase": "dogfood",
  "updatedAt": "2026-04-12T00:00:00.000Z"
}
```

#### Error Conditions / Edge Cases
- Unknown base alias (not recognized and not path-like) -> return `INVALID_BASE` with corrective guidance.
- Empty base input -> return usage help and non-zero exit.
- Persist write failure (permissions/home dir unavailable) -> return `CONFIG_WRITE_FAILED` and keep runtime unchanged.
- `KB_BASE_DIR` set explicitly -> continues to override persisted default by design.
- `kb use` in non-evaluated shells -> command prints explicit export instruction text so behavior is transparent.

#### Decisions Made
- ✅ Decided: Keep env vars authoritative over persisted defaults. -> Rationale: preserves automation/CI determinism.
- ✅ Decided: Persist only default alias and timestamp in user config. -> Rationale: minimal, portable config surface.
- ✅ Decided: Support alias-first model (`dogfood`, `ci-*`, `test-*`) with optional path fallback. -> Rationale: aligns with existing namespace strategy while allowing advanced usage.

#### Integration Points
- Extends ticket 006 environment-loading behavior with user-level persisted defaults.
- Aligns with ticket 010 session lifecycle by making context selection explicit.
- Complements ticket 057 consumer CLI UX by introducing top-level ergonomic commands.
- Follow-up implementation should include:
  - config read/write utility module,
  - CLI parser wiring for `use/default`,
  - test matrix for precedence and errors.

#### Validation & Closure
This implementation plan establishes:
- ✅ Command contract and examples for `kb use` and `kb default`.
- ✅ Deterministic precedence order including backward compatibility behavior.
- ✅ Error model and integration boundaries for implementation.

**Ticket 062 is now closed.**
