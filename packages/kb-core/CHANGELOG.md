# @kb/core

## 1.2.0

### Minor Changes

- Split GitHub release artifacts and versioning for `@kb/client` / `@kb/server`; shared release-uninstall helpers and env-only client configuration (`KB_HOST`/`KB_PORT`, base state under `~/.kb/state/`).

### Patch Changes

- Split uninstall: client-only vs `kb-server uninstall --purge`.
- Fix TUI bundle esbuild banner, run telemetry token counts, and query pipeline logging.
- Support client-side indexing removal and connection-context formatting for remote-only workflows.

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
