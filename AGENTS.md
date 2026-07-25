# AGENTS.md

Guidance for AI agents (Codex and others) working in this repository.

See also `CLAUDE.md` for the full agent guide. Monorepo layout: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md).

## Changesets are mandatory for source changes

Any change to shipped code under `packages/kb-core/`, `packages/kb-client/`, or
`packages/kb-server/` **must** ship an applied version bump on the branch before merging.
Docs/eval/research/CI/config-only PRs are exempt.

Create one pending `.changeset/<name>.md` file directly in agent/non-interactive work:

```md
---
"@kb/client": minor
---

Short summary of the change.
```

Then apply it with:

```bash
pnpm run changeset:version
```

This consumes the pending changeset, bumps `package.json` / `CHANGELOG.md`,
and rewrites `research/version.tex`. Do not hand-edit those version files.

**Strict semver:** each affected package moves exactly one step (patch, minor, or major) vs the merge base — no `1.1.4 → 1.3.0`. Enforced by CI, `pre-commit` (`--staged`), and `pre-push` (`--push`) via `scripts/check-changeset-consistency.mjs`.

**`@kb/core` version is internal-only.** Still bump via changesets when core source changes. Never print it on user-facing surfaces (CLI/TUI, `kb-server` start/`--version`, `/healthz`, MCP metadata, operator logs) — those show `@kb/client` / `@kb/server` only. Core semver is for workspace dependency tracking and snapshot manifest provenance.

## Boolean environment variables

Do **not** use `1`, `0`, `yes`, `on`, or other aliases for true/false in
`process.env.*` or docs/examples. Use `true` and `false` only.

- Use `@kb/core/config/env-boolean` (`isEnvTrue`, `parseBooleanEnv`, etc.).
- Docs/tests: `KB_GRAPH=true`, not `=1`.
- **Exception:** third-party APIs that require numeric booleans — convert at
  the boundary only; KB env vars stay `true`/`false`.
