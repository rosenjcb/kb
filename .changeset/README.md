# Changesets

Two workspace packages, versioned **together** (`fixed` in `config.json`):

| Package | Directory | What it covers |
|---------|-----------|----------------|
| `kb` | repo root | CLI, `src/server/` runtime, core |
| `kb-server` | `packages/kb-server/` | Dockerfile, compose, httpyac suite, WireMock stubs |

One `package.json` version (`kb`) is what the binary, Docker image, and MCP report (`KB_VERSION`). `kb-server` tracks packaging/integration paths so Changesets can detect them separately.

## Workflow

1. Create one pending `.changeset/*.md` file for the PR. In agent/non-interactive work, write it directly; for the wizard, run the native Changesets CLI yourself.
2. `pnpm run changeset:version` — applies the pending changeset, bumps the affected package versions / changelogs, and rewrites `research/version.tex`.
3. `pnpm run changeset:check` — verifies the bump was applied and no pending changeset remains.
4. Merge once `changeset:check` passes.

## Native CLI flags

- `--since main` (or `--since origin/main` via our `--base` alias) — compare git diff to base branch; only changed packages appear in `add` / `status`.
- Docs: [Changesets command-line options](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md)

## Bump types

| Type | When |
|------|------|
| `patch` | Fixes |
| `minor` | New features (`kb server start`, new commands) |
| `major` | Breaking CLI / API changes |

When both packages change, one changeset file can list both:

```md
---
"kb": minor
"kb-server": minor
---
```
