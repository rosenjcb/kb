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

**Agents default to `patch`.** Do not infer `minor`/`major` from your own impact
assessment — use `patch` unless the user explicitly asks for a different bump
type in that conversation.

## Boolean environment variables

Do **not** use `1`, `0`, `yes`, `on`, or other aliases for true/false in
`process.env.*` or docs/examples. Use `true` and `false` only.

- Use `@kb/core/config/env-boolean` (`isEnvTrue`, `parseBooleanEnv`, etc.).
- Docs/tests: `KB_GRAPH=true`, not `=1`.
- **Exception:** third-party APIs that require numeric booleans — convert at
  the boundary only; KB env vars stay `true`/`false`.

## Cursor Cloud specific instructions

Environment is pre-provisioned. The startup update script selects the pinned
Node (`nvm use` → `.nvmrc` 24.15.0) and runs `pnpm install` from the repo root —
`pnpm install` also runs the `preinstall` Node-version guard and husky
`prepare`, and pulls in the `@rosenjcb/spec-md` CLI (a workspace devDependency,
not a global). Standard dev commands live in
[`DEVELOPERS_GUIDE.md`](DEVELOPERS_GUIDE.md) and root `package.json`
(`install:global` = deps + build + global `kb`/`kb-server` symlinks, `build`,
`type-check`, `lint`, `test`/`unit:test`, `spec:check`, `server:start`). Do not
re-document them.

- **`pnpm install` hands git hooks to husky.** The `prepare` script runs husky,
  which sets `core.hooksPath` to `.husky/_` and supersedes Cursor's agent-hooks
  dispatcher (so Cursor's own commit hooks stop firing — expected). Every
  `git commit` then runs the full `precommit` gate (`changeset:check --staged` →
  `lint:fix:staged` → `type-check` → `lint` → `spec:check` → `test`, ~40s) and
  `git push` runs `prepush` (`changeset:check --push`). A source change under
  `packages/kb-*` with no applied changeset fails the commit — add/apply one
  first (see top of this file). `spec:check` is the `spec-md coverage` gate;
  `spec:lint` reports pre-existing spec-content warnings and is **not** part of
  the commit gate.

- **Node/pnpm resolution (non-obvious).** The VM's default `node` on `PATH`
  (`/exec-daemon/node`) is v22, but this repo requires Node 24 (`preinstall`
  hard-fails otherwise). Setup made **Node 24.15.0 + pnpm 10.33.3** the default
  by symlinking `node`/`npm`/`npx`/`corepack`/`pnpm` into `/usr/local/cargo/bin`
  (first on `PATH`) and setting `nvm alias default 24.15.0`, so plain `node` /
  `pnpm` already resolve to 24 in login and non-interactive shells — no `nvm use`
  needed. If a fresh pod ever shows Node 22, re-run
  `corepack prepare pnpm@10.33.3 --activate` and re-create those symlinks from
  `~/.nvm/versions/node/v24.15.0/bin`.
- **Package manager is pnpm.** A stray `package-lock.json` exists alongside
  `pnpm-lock.yaml` / `pnpm-workspace.yaml`; ignore npm and always use pnpm.
- **The built client `packages/kb-client/dist/bin/kb` is a bash wrapper** — run
  it directly (`./packages/kb-client/dist/bin/kb ...`), never `node <path>`.
- **Running kb-server end-to-end without a real LLM key or Docker.** Docker is
  not installed, so `integration:test` / `server:up` won't run as-is. To exercise
  the full query path locally, replicate the WireMock LLM stub with the installed
  JDK: `java -jar <wiremock-standalone.jar> --port 8080 --root-dir
  packages/kb-server/docker/wiremock --global-response-templating`, then start the
  server with `GEMINI_API_KEY=integration-mock-key`,
  `GEMINI_API_BASE_URL=http://localhost:8080`, plus `KB_GIT_REPOS=<repo>`,
  `KB_BASE=demo`, `KB_SERVER_API_KEY=testkey`, `KB_REINDEX_INTERVAL=0`, and
  `pnpm run server:start`. First boot clones + indexes the repo (embeddings run
  locally via `Xenova/all-MiniLM-L6-v2`, no API needed); only answer synthesis
  hits the mock. Then query: `KB_SERVER_API_KEY=testkey
  ./packages/kb-client/dist/bin/kb query "..."`. Provide a real provider key
  instead (e.g. `GEMINI_API_KEY`) for genuine answers.
- **Server runs as a detached daemon.** `pnpm run server:start` backgrounds it;
  logs at `~/.kb/logs/kb-server.{out,err}.log`; manage via `pnpm run
  server:status` / `server:stop`. Health: `curl localhost:38117/healthz`.
- **kb MCP entry is registered (user scope, not in-repo).** `kb mcp install
  --host https://kb-demo.fly.dev` writes `mcpServers.kb → <host>/mcp` into
  `~/.cursor/mcp.json`, `~/.claude.json`, and the Antigravity configs (see
  `packages/kb-client/src/api/mcp-config-sync.ts`); the hosted demo needs no
  bearer key. Gotcha: an exported `KB_SERVER_API_KEY` leaks into the written
  entry as an `Authorization` header — run `kb mcp install` from a shell without
  it for a key-free entry. Re-point/remove with `kb mcp install --host <url>` /
  `kb mcp uninstall`; inspect with `kb mcp status`. The `kb_query` MCP tool takes
  arg `q` (not `query`). Two more MCP tools close the feedback loop:
  `submit_feedback` (`helped` = `yes`/`partial`/`no`, optional
  `notes`/`answer`/`query`/`requestId`/`scores` — one `requestId` per call, no
  array batching; omit it for general feedback) records answer-quality feedback
  to `~/.kb/feedback/` on the server and echoes the full record back; `kb_query`
  responses echo a `requestId` to reference in it, and `KB_FEEDBACK_SAMPLE_RATE`
  (server-side, default 0) still gates *whether* to ask on a sampled fraction of
  responses. When the client supports form elicitation and
  `KB_MCP_ELICITATION` is on (default `true`; set `false` to opt out), that ask
  is a yes/partial/no user form; otherwise a top-level `AGENT_INSTRUCTION` key
  (not buried in `notes`) asks the agent to call `submit_feedback`, queuing
  that `requestId` in an in-memory pending store; `get_feedback_requests` lists
  what's still outstanding in that queue.
- **`kb skills install` is the fuller setup** (see
  `packages/kb-client/src/cli/skill-installer.ts`): it also installs the
  `kb:*` skill files, a profile blurb (`~/.claude/CLAUDE.md` etc.), and the
  kb-first **hook** (`~/.kb/hooks/kb-reminder.sh`, registered as a `PreToolUse`
  hook in `~/.claude/settings.json` — nudges agents to call `kb_query` before
  `grep`/`rg`/`find`/`Grep`/`Glob`) and the **end-of-session feedback hook**
  (`~/.kb/hooks/kb-feedback.sh`, Claude Code only: tracks kb_query use per
  session, then asks once — at the first `git push`, or by blocking the first
  Stop — to call `get_feedback_requests` and resolve what it returns via
  `submit_feedback`; opt out with `KB_FEEDBACK_REMINDER=false`). It **re-syncs
  MCP config to localhost by
  default**, so run it as `kb --host https://kb-demo.fly.dev skills install`
  (host flag goes before the subcommand) to keep the remote entry. Reverse with
  `kb skills uninstall`.
