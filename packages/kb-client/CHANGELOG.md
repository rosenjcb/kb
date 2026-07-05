# @kb/client

## 1.3.0

### Minor Changes

- Configuration is environment-only: standardize on `KB_HOST`/`KB_PORT`, remove `kb config set`/`unset`, migrate base selection to `~/.kb/state/`, and rewrite README quick-start.

### Patch Changes

- Updated dependencies
  - @kb/core@1.2.0

## 1.2.2

### Patch Changes

- Fix TUI esbuild assert crash, server run telemetry (tokens, host/target column, plain command names), connection-error hints, and relax the CI version-jump gate for long-lived PRs.
- Updated dependencies
  - @kb/core@1.1.7

## 1.2.1

### Patch Changes

- Split uninstall: `kb uninstall` removes client only; `kb-server uninstall --purge` removes server and ~/.kb server data.
- Updated dependencies
  - @kb/core@1.1.6

## 1.2.0

### Minor Changes

- Split GitHub release into `kb-client-node24.tgz` and `kb-server-node24.tgz`; `install-kb.sh` and `kb sync` install both by default (`--client-only` / `--server-only` for one side). Wire release CI to `@kb/client` / `@kb/server` versions and changelogs.

### Patch Changes

- Updated dependencies
  - @kb/core@1.1.5

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
