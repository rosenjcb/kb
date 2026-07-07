# @kb/core

## 1.3.0

### Minor Changes

- f22e369: Add a generic build-to-serve handoff model. `@kb/core` gains a versioned
  prepared-state artifact contract (`kb-prepared.json`) with provenance,
  integrity digest, and a forward-only index-schema compatibility check.
  `kb-server` gains `export`/`import` subcommands to snapshot a built base into a
  portable bundle and restore it elsewhere, plus a `--bootstrap-policy`
  (`KB_SERVER_BOOTSTRAP_POLICY`) `prepared-only` mode so a lightweight worker
  serves pre-built state without ever running the heavy build.

## 1.2.3

### Patch Changes

- Purge the `meta.json` / `.kbignore` / `kb-server.json` config layer — the server is now configured entirely through environment variables (these are Docker service nodes, not local checkouts). Repos and their branches come from `KB_SERVER_BASE_GIT_REPOS` (inline `url#branch`), index-ignore patterns from the new `KB_SERVER_IGNORE`, and a base's tracked repos are discovered from the git clones on its volume rather than a persisted sidecar file. Drops the `kb base repo` and `kb base ignore` commands and the `kb-server.json` bootstrap manifest.

## 1.2.2

### Patch Changes

- Remove unintentional flags that were never meant to ship: `--type` and `--limit` on `kb query` (CLI parsing and help, remote client forwarding, HTTP query request fields, OpenAPI schema, and the `kb_query` MCP tool input), and `--type` on `docs generate` (the doc type is now always classified from the prompt). Fact retrieval uses the server-side defaults. The separate `docs list`/`docs generate`/`facts`/`logs` `--limit` options and `graph node --type` are unchanged.

## 1.2.1

### Patch Changes

- c204d60: Fixed small eval test issue.

## 1.2.0

### Minor Changes

- Split GitHub release artifacts and versioning for `@kb/client` / `@kb/server`; shared release-uninstall helpers and env-only client configuration (`KB_HOST`/`KB_PORT`, base state under `~/.kb/state/`).

### Patch Changes

- Split uninstall: client-only vs `kb-server uninstall --purge`.
- Fix TUI bundle esbuild banner, run telemetry token counts, and query pipeline logging.
- Connection-context formatting for remote-only client workflows; env-only configuration messaging.

## 1.1.4

### Patch Changes

- Standardize the default kb-server listen port to 38117 (CLI, Docker, client fallback, eval harness).

## 1.1.3

### Patch Changes

- Add `KB_QUERY_TIMEOUT`, fix `/healthz` readiness during bootstrap, and restore remote `kb query --trace`.

## 1.1.2

### Patch Changes

- Fix client/server split gaps: forward `--type`/`--verbose` on remote `kb query`, let the TUI chat run against a remote server without a local base or LLM key, stop nagging about a missing local API key in remote mode, and correct the server-side `kb graph --base` argument handling so it targets the requested base.

## 1.1.1

### Patch Changes

- Standardize boolean env vars to `true`/`false` only; bundle JS deps in CLI/server builds so global install resolves runtime modules.

## 1.1.0

### Minor Changes

- Route all kb commands through kb-server REST: POST /v1/admin/cli for init/scan/docs/facts/graph/logs/publish/base; client remote dispatch by default.

## 1.0.0

### Major Changes

- 1.0.0 client-server split: `kb` CLI/TUI client, `kb-server` daemon, `@kb/core` shared domain. Remote query/chat over REST+SSE; `kb server` subcommand removed.

## 0.22.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.
