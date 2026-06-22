# Changesets

Two workspace packages, versioned **together** (`fixed` in `config.json`):

| Package | Directory | What it covers |
|---------|-----------|----------------|
| `kb` | repo root | CLI, `src/server/` runtime, core |
| `kb-server` | `packages/kb-server/` | Dockerfile, compose, httpyac suite, WireMock stubs |

One `package.json` version (`kb`) is what the binary, Docker image, and MCP report (`KB_VERSION`). `kb-server` tracks packaging/integration paths so Changesets can detect them separately.

## Workflow

1. `pnpm run changeset:check` — `changeset status --since main` (native: which packages changed) + policy check (no version bump in PR).
2. `pnpm run changeset` — same check, then `changeset add --since main` (wizard only lists changed packages).
3. Commit the pending `.changeset/*.md` — **do not** bump `package.json` / `CHANGELOG.md` in the feature PR.
4. Merge to `main` → Changesets action runs `changeset version` → Version Packages PR → `0.11.0`.

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
