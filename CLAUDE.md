# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository.

## Changesets are mandatory for source changes

Any change to shipped code under `src/` or `bin/` **must** include a version
bump via Changesets. CI enforces this with the `Changeset required` job in
`.github/workflows/ci.yml`, which hard-fails a PR that touches `src/`/`bin/`
without a changeset. Docs/eval/research/CI/config-only PRs are exempt.

**Do not hand-author changeset markdown files.** Generate them with the
tooling so the format, package name, and bump type are correct:

```bash
pnpm run version
```

This wraps Changesets (`scripts/update-research-version.mjs`):

1. Runs the interactive `changeset` wizard so you pick the bump
   (`patch` / `minor` / `major`) and write the summary.
2. Runs `changeset version` to consume the changeset(s) — bumping
   `package.json`, updating `CHANGELOG.md`, and regenerating
   `research/version.tex`.

Commit the resulting changes (the version bump and changelog, or the pending
`.changeset/*.md` file) along with your code. The CI check passes when either a
pending changeset exists or `CHANGELOG.md` was updated in the PR.

Pick the bump type by impact: `patch` for fixes, `minor` for new or removed
features / behavior changes (this pre-1.0 project uses `minor` for breaking
CLI changes rather than jumping to 1.0.0), `major` for an intentional 1.0+
break.

## Common commands

- `pnpm run type-check` — TypeScript type check
- `pnpm run lint` — Biome lint
- `pnpm run test` — Vitest
- `pnpm run build` — compile + build the CLI
- `pnpm run version` — create a changeset and bump the version (see above)
