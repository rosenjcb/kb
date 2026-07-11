# @kb/client

## 1.3.1

### Patch Changes

- Fix the kb MCP server to work end-to-end, as it should have since 1.0.0.

  - MCP `kb_query` is now a single, answer-first agent-to-agent tool: it always
    synthesizes a direct answer (no `synthesize` flag) and surfaces the physical
    source files behind each fact instead of opaque `fact://` URIs.
  - kb-server gains a real daemon lifecycle — `start -d` / `stop` / `status` /
    `restart` (pid file under `~/.kb/run`, with a pid-reuse guard on stop) — plus
    `kb-server init` and `kb-server service install|uninstall|status` for
    launchd/systemd. `server:start` now backgrounds the server.
  - Add Google Antigravity / Antigravity CLI support for MCP config sync, global
    skill installation, and BeforeTool hooks.
  - `kb skills install` / `kb mcp install` write MCP configs for the active
    CLI/TUI connection (localhost default) instead of requiring an explicit
    `--host` / env and printing `needs-host`.

- Updated dependencies
  - @kb/core@1.4.4

## 1.3.0

### Minor Changes

- Keep `@kb/core` version internal: CLI/TUI and `kb-server` surfaces show client/server semver only; drop `version.core` from `/healthz` and MCP metadata.

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.3

## 1.2.10

### Patch Changes

- Agents investigate via the kb MCP connection only (CLI/TUI is for humans). Add `kb mcp install|status|uninstall` so Cursor/Claude `mcpServers.kb` points at an **explicit** local or remote host (`--host`, `KB_SERVER_URL`, `KB_HOST`, or `config.server.host`) — never an invented localhost default. Pass loaded `KbConfig` into MCP sync (Bearer from `config.server.apiKey`), exit non-zero on `needs-host` / install failures, and clear stale Authorization when no API key is set. Fix Claude Code hooks: emit PreToolUse JSON `additionalContext` (plain stdout was ignored), match `Bash|Grep|Glob`, and always create `~/.claude` on install. Document team remote setup in the README (shared server → human CLI + agent MCP).
- Keep `kb mcp` client-local so remote mode does not forward it to `/v1/admin/cli`. Stop auto-installing agent skills and rewriting MCP configs on CLI/TUI startup (opt-in via `kb skills install` / `kb mcp install` only).
- Type `HealthResponse.version` for `/healthz` (`server` + `core` package versions).
- Renumber colliding skill-installer / remote-command TC IDs (TC-630–633, TC-626) so CONNECTION vs CLI ownership is unique.
- Updated dependencies
  - @kb/core@1.4.2

## 1.2.9

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.1

## 1.2.8

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.0

## 1.2.7

### Patch Changes

- Fix two client bugs: surface a clear, red, actionable message (pointing at
  `KB_SERVER_API_KEY`) when the server rejects a request for want of an API key
  instead of a bare "unauthorized", and stream the server's reasoning/progress
  into the chat spinner so it shows live status rather than a frozen "thinking...".

## 1.2.6

### Patch Changes

- Fix release runtime packaging so install and sync extract self-contained release artifacts instead of relying on npm workspace tarballs.

## 1.2.5

### Patch Changes

- Updated dependencies
  - @kb/core@1.3.1

## 1.2.4

### Patch Changes

- Updated dependencies [f22e369]
  - @kb/core@1.3.0

## 1.2.3

### Patch Changes

- Purge the `meta.json` / `.kbignore` / `kb-server.json` config layer — the server is now configured entirely through environment variables (these are Docker service nodes, not local checkouts). Repos and their branches come from `KB_SERVER_BASE_GIT_REPOS` (inline `url#branch`), index-ignore patterns from the new `KB_SERVER_IGNORE`, and a base's tracked repos are discovered from the git clones on its volume rather than a persisted sidecar file. Drops the `kb base repo` and `kb base ignore` commands and the `kb-server.json` bootstrap manifest.
- Updated dependencies
  - @kb/core@1.2.3

## 1.2.2

### Patch Changes

- Remove unintentional flags that were never meant to ship: `--type` and `--limit` on `kb query` (CLI parsing and help, remote client forwarding, HTTP query request fields, OpenAPI schema, and the `kb_query` MCP tool input), and `--type` on `docs generate` (the doc type is now always classified from the prompt). Fact retrieval uses the server-side defaults. The separate `docs list`/`docs generate`/`facts`/`logs` `--limit` options and `graph node --type` are unchanged.
- Updated dependencies
  - @kb/core@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c204d60]
  - @kb/core@1.2.1

## 1.2.0

### Minor Changes

- Split GitHub release into `kb-client-node24.tgz` and `kb-server-node24.tgz`; `install-kb.sh` and `kb sync` install both by default. Wire release CI to `@kb/client` / `@kb/server` versions and changelogs.
- Configuration is environment-only: `KB_HOST`/`KB_PORT`, base selection in `~/.kb/state/`. README and DEVELOPERS_GUIDE describe server-managed indexing.
- Server-managed indexing on kb-server (`KB_GIT_REPOS`); client adds global `kb --host` and shows connected host/base in the TUI status bar and CLI banner.

### Patch Changes

- Split uninstall: `kb uninstall` removes client only; `kb-server uninstall --purge` removes server and `~/.kb` data.
- Fix TUI esbuild assert crash, server run telemetry (tokens, host/target column, plain command names), and connection-error hints.
- Enforce strict single-step semver version bumps in CI and git hooks (pre-commit staged guard, pre-push merge gate).
- `pnpm run install:global` installs deps, builds, and symlinks `kb` + `kb-server` for local dev and eval.
- Updated dependencies
  - @kb/core@1.2.0

## 1.1.4

### Patch Changes

- Standardize the default kb-server listen port to 38117 (CLI, Docker, client fallback, eval harness).
- Updated dependencies
  - @kb/core@1.1.4

## 1.1.3

### Patch Changes

- Add `KB_QUERY_TIMEOUT`, fix `/healthz` readiness during bootstrap, and restore remote `kb query --trace`.
- Updated dependencies
  - @kb/core@1.1.3

## 1.1.2

### Patch Changes

- Fix client/server split gaps: forward `--type`/`--verbose` on remote `kb query`, let the TUI chat run against a remote server without a local base or LLM key, stop nagging about a missing local API key in remote mode, and correct the server-side `kb graph --base` argument handling so it targets the requested base.
- Updated dependencies
  - @kb/core@1.1.2

## 1.1.1

### Patch Changes

- Standardize boolean env vars to `true`/`false` only; bundle JS deps in CLI/server builds so global install resolves runtime modules.
- Updated dependencies
  - @kb/core@1.1.1

## 1.1.0

### Minor Changes

- Route all kb commands through kb-server REST: POST /v1/admin/cli for init/scan/docs/facts/graph/logs/publish/base; client remote dispatch by default.

### Patch Changes

- Updated dependencies
  - @kb/core@1.1.0

## 1.0.0

### Major Changes

- 1.0.0 client-server split: `kb` CLI/TUI client, `kb-server` daemon, `@kb/core` shared domain. Remote query/chat over REST+SSE; `kb server` subcommand removed.

### Patch Changes

- Updated dependencies
  - @kb/core@1.0.0

## 0.22.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.

### Patch Changes

- Updated dependencies
  - @kb/core@0.22.0
  - @kb/server@0.14.0
