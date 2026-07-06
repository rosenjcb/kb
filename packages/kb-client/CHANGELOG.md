# @kb/client

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
