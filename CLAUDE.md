# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository.

## Changesets are mandatory for source changes

Any change to shipped code under `src/` or `bin/` **must** include a changeset.
CI enforces this with the `Changeset required` job in `.github/workflows/ci.yml`,
which hard-fails a PR that touches `src/`/`bin/` without a pending changeset.
Docs/eval/research/CI/config-only PRs are exempt.

**The version bump happens on merge to main, NOT in your PR.** Feature PRs carry
a *pending* `.changeset/*.md` and must **not** touch the version files
(`package.json`, `CHANGELOG.md`, `research/version.tex`). On merge to main, the
Changesets GitHub Action (`.github/workflows/changesets.yml`) consumes the pending
changesets and opens a "Version Packages" PR that performs the bump and updates
the changelog. Do not run `changeset version` yourself, and do not hand-edit the
version files.

Add a changeset with:

```bash
pnpm run changeset
```

Locally this only runs the interactive wizard to **create** a pending changeset
(pick `patch` / `minor` / `major` and write the summary) — it does not bump the
version. In a non-interactive / agent session where the wizard can't run, write
the `.changeset/<name>.md` file directly with the correct frontmatter:

```md
---
"kb": minor
---

Short summary of the change.
```

Leave the `.changeset/*.md` file in the PR; do not commit any change to
`package.json`, `CHANGELOG.md`, or `research/version.tex`.

Pick the bump type by impact: `patch` for fixes, `minor` for new or removed
features / behavior changes (this pre-1.0 project uses `minor` for breaking
CLI changes rather than jumping to 1.0.0), `major` for an intentional 1.0+
break.

## Common commands

- `pnpm run type-check` — TypeScript type check
- `pnpm run lint` — Biome lint
- `pnpm run unit:test` — Vitest unit/integration tests (alias: `pnpm run test`)
- `pnpm run integration:test` — spin up the server in Docker and run the httpyac
  suite (`http/server.http`) against it, then tear down (Docker only; LLM stubbed via
  WireMock sidecar — see `http/HTTP.md`)
- `pnpm run server:start` / `server:stop` — Docker Compose kb-server (+ llm-mock)
- `pnpm run mcp:start` / `mcp:stop` — local stdio MCP for IDE clients; stop kills
  MCP HTTP listener on `PORT` when using `mcp start --http`
- `pnpm run build` — compile + build the CLI
- `pnpm run changeset` — create a *pending* changeset (no version bump; see above)
