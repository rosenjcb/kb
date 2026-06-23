# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository.

## Versioning: bump on the branch before merging (it is NOT automatic)

Any change to shipped code under `src/` or `bin/` (the **kb** package) or
`packages/kb-server/` (the **kb-server** package) **must** ship an applied version
bump. The version bump is a deterministic step **you run on the branch** — nothing
bumps automatically after merge. CI enforces it with the `Version bump required`
job in `.github/workflows/ci.yml`, which hard-fails a PR into main that:

- changed shipped source without bumping the affected package, or
- still carries an unapplied `.changeset/*.md`, or
- carries **more than one** `.changeset/*.md` (one changeset per PR), or
- bumped a package version by **more than one semver step** (no double-jumps).

Docs/eval/research/CI/config-only PRs are exempt from the bump requirement.

`kb` and `kb-server` are versioned **independently** (no `fixed`/`linked` link in
`.changeset/config.json`) — bump only the package(s) whose source changed; their
numbers may drift apart.

The two-step flow on your branch:

1. **Draft a changeset** describing the change and bump type:

   ```bash
   pnpm run changeset
   ```

   This runs the interactive wizard (changed packages only) to create a *pending*
   `.changeset/*.md`. In a non-interactive / agent session where the wizard can't
   run, write the file directly with the correct frontmatter — list each affected
   package:

   ```md
   ---
   "kb": minor
   ---

   Short summary of the change.
   ```

2. **Apply the bump** (consumes the changeset, bumps each package's `package.json`
   + `CHANGELOG.md`, and regenerates `research/version.tex`):

   ```bash
   pnpm run changeset:version
   ```

Commit the result — the bumped version files **and** the now-removed changeset —
on your branch. Do not hand-edit `package.json` versions, `CHANGELOG.md`, or
`research/version.tex`; let `changeset:version` produce them.

On merge to main, `.github/workflows/changesets.yml` only **publishes** (tag +
release) — it does not version, because the versions already landed on the branch.

Pick the bump type by impact: `patch` for fixes, `minor` for new or removed
features / behavior changes (this pre-1.0 project uses `minor` for breaking
CLI changes rather than jumping to 1.0.0), `major` for an intentional 1.0+
break.

## Common commands

- `pnpm run type-check` — TypeScript type check
- `pnpm run lint` — Biome lint
- `pnpm run unit:test` — Vitest unit/integration tests (alias: `pnpm run test`)
- `pnpm run integration:test` — spin up the server in Docker and run the httpyac
  suite (`packages/kb-server/http/server.http`) against it, then tear down (Docker only; LLM stubbed via
  WireMock sidecar — see `packages/kb-server/http/HTTP.md`)
- `pnpm run server:start` / `server:stop` — Docker Compose kb-server (+ llm-mock)
- `pnpm run build` — compile + build the CLI
- `pnpm run changeset` — draft a *pending* changeset (no version bump; see above)
- `pnpm run changeset:version` — apply the bump (consume changesets, bump kb / kb-server, regen version.tex)
- `pnpm run changeset:check` — run the merge-to-main version gate locally (same check CI runs)
