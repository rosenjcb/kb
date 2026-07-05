# Changesets

Three workspace packages, versioned **independently**:

| Package | Directory | What it covers |
|---------|-----------|----------------|
| `@kb/client` | `packages/kb-client/` | `kb` CLI/TUI, HTTP SDK |
| `@kb/core` | `packages/kb-core/` | Indexing, retrieval, LLM, `KbService` |
| `@kb/server` | `packages/kb-server/` | `kb-server` daemon, Docker, httpyac suite |

Bump only the package(s) whose shipped source changed. CI and git hooks enforce one applied changeset per PR and **exactly one semver step** per affected package (patch, minor, or major — no skipping versions).

## Workflow

1. Create one pending `.changeset/*.md` file for the PR. In agent/non-interactive work, write it directly; for the wizard, run the native Changesets CLI yourself.
2. `pnpm run changeset:version` — applies the pending changeset, bumps the affected package versions / changelogs, and rewrites `research/version.tex`.
3. `pnpm run changeset:check` — verifies the bump was applied and no pending changeset remains (same check as CI and the `pre-push` hook vs `origin/main`).
4. Merge once `changeset:check` passes.

**Git hooks:** `pre-commit` runs the staged guard (`changeset:check:staged`); `pre-push` runs the merge gate vs `origin/main`.

## Native CLI flags

- `--since main` (or `--since origin/main` via our `--base` alias) — compare git diff to base branch; only changed packages appear in `add` / `status`.
- Docs: [Changesets command-line options](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md)

## Bump types

| Type | When |
|------|------|
| `patch` | Fixes |
| `minor` | New features |
| `major` | Breaking CLI / API changes |

Example frontmatter for a client-only change:

```md
---
"@kb/client": minor
---

Short summary.
```

Multi-package changes list each package in the frontmatter block.
