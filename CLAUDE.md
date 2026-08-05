# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository.

## Versioning: bump on the branch before merging (it is NOT automatic)

Any change to shipped code under `packages/kb-core/`, `packages/kb-client/`, or
`packages/kb-server/` **must** ship an applied version bump. The version bump is a deterministic step **you run on the branch** — nothing
bumps automatically after merge. CI enforces it with the `Version bump required`
job in `.github/workflows/ci.yml`, which hard-fails a PR into main that:

- changed shipped source without bumping the affected package, or
- still carries an unapplied `.changeset/*.md`, or
- carries **more than one** `.changeset/*.md` (one changeset per PR), or
- bumped a package version backward or not at all when its source changed, or
- bumped a package version by **more than one semver step** (no double-jumps — e.g. `1.1.4 → 1.3.0` fails; one changeset + one bump per PR), or

Docs/eval/research/CI/config-only PRs are exempt from the bump requirement.

`@kb/client`, `@kb/server`, and `@kb/core` are versioned **independently** — bump only the package(s) whose source changed.

**`@kb/core` version is internal-only.** Bump it when core source changes (changeset + `package.json`), and it may appear in snapshot manifest provenance (`producer.coreVersion`). Do **not** surface it in user-facing CLI/TUI banners, `kb --version` / `kb-server --version`, server start lines, `/healthz`, MCP server metadata, or operator log lines — those use `@kb/client` / `@kb/server` only.

The two-step flow on your branch:

1. **Create one pending changeset** describing the change and bump type.

   In agent / non-interactive work, write the `.changeset/*.md` file directly
   with the correct frontmatter — list each affected package:

   ```md
   ---
   "@kb/client": minor
   ---

   Short summary of the change.
   ```

   If you want the interactive wizard, run the native Changesets CLI yourself;
   this repo no longer wraps it in a `package.json` script.

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
features / behavior changes, `major` for intentional breaking changes (1.0+).

**Agents default to `patch`.** Do not infer `minor`/`major` from your own
assessment of impact (e.g. "this removes a public env var, so it's breaking") —
use `patch` unless the user explicitly asks for a different bump type in that
conversation.

## Common commands

- `pnpm run type-check` — TypeScript type check (all packages)
- `pnpm run lint` — Biome lint
- `pnpm run unit:test` — Vitest unit/integration tests (alias: `pnpm run test`)
- `pnpm run integration:test` — Docker + httpyac against `kb-server`
- `pnpm run server:start` / `server:up` — local kb-server
- `pnpm run build` — compile `kb` + `kb-server` binaries
- `pnpm run changeset:version` — apply the bump
- `pnpm run changeset:check` — merge-to-main version gate (same as CI + `pre-push`)
- `pnpm run changeset:check:staged` — staged-source guard (`pre-commit`)

Git hooks: **pre-commit** → staged guard + lint/tests; **pre-push** → `changeset:check` vs `origin/main`.

Monorepo layout → [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md).

## Local environment / toolchain

A fresh container does not arrive ready. Establish these before running anything,
and re-establish the shell ones in **every** shell — tool calls do not persist shell
state between invocations.

- **Node 24 is required** (`engines.node >=24`). `pnpm` hard-fails on anything older
  with `ERR_PNPM_UNSUPPORTED_ENGINE`, so this blocks lint/test/build entirely:

  ```bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24 && nvm use 24
  ```

- **`node_modules` may be absent** even though `package.json` is present (a bare
  `tsc --noEmit` then fails with `Cannot find type definition file for 'node'`).
  Run `pnpm install --frozen-lockfile`.

- **`flyctl` is installed at `~/.fly/bin/flyctl`, which is not on `PATH`.** A bare
  `command -v flyctl` returns nothing — that is not evidence it is missing. Prepend
  `export PATH="$HOME/.fly/bin:$PATH"` in the shell that needs it.

  A setup script cannot fix this by ending in `export PATH=...`: the export dies with
  the script's process and never reaches later shells. To make it stick, have the
  setup script write to a profile or link into an existing `PATH` entry:

  ```bash
  ln -sf "$HOME/.fly/bin/flyctl" /usr/local/bin/flyctl
  echo 'export PATH="$HOME/.fly/bin:$PATH"' >> ~/.bashrc
  ```

- **Git hooks are slow.** `pre-commit` runs the full Vitest suite (~40s plus
  startup), which overruns short command timeouts and leaves the commit looking like
  it failed when it was merely still running. Give a commit several minutes.

- **Verify the resolved LLM provider rather than assuming a key is set.** With no
  key, `kb-server` falls back to `ollama/mistral` and fails later at synthesis
  instead of at startup. The server's `server start` log line names the provider.

## Boolean environment variables

Do **not** use `1`, `0`, `yes`, `on`, or other aliases for true/false in
`process.env.*` or docs/examples. Use the strings `true` and
`false` only (lowercase when writing env vars).

- Parse flags with `@kb/core/config/env-boolean` (`isEnvTrue`, `isEnvFalse`,
  `parseBooleanEnv`, `parseBooleanConfigValue`, `booleanEnvString`).
- Docs and tests: `KB_GRAPH=true`, not `=1`.
- **Exception:** when a third-party library or protocol requires a numeric
  boolean at its API boundary, convert at that call site only — do not adopt
  that convention for KB env vars or config.
