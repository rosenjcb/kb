# kb-server

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

- Split uninstall: `kb-server uninstall --purge` removes server binary and `~/.kb` data; client uninstall is client-only.

### Patch Changes

- Fix run telemetry on `/v1/query` and `/v1/chat` (real LLM token counts, plain command names).
- Align with env-only client configuration and release CI version wiring.
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

## 0.14.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.

### Patch Changes

- Updated dependencies
  - @kb/client@0.22.0
  - @kb/core@0.22.0

## 0.13.2

### Patch Changes

- Adopt spec.md behavioral specs (FR/TC tables), test `[TC-N]` tags, and a CI traceability gate.

## 0.13.1

### Patch Changes

- Fix kb-server's scheduled reindex behavior, restore Docker Slack env wiring, and simplify the changeset workflow so `changeset:version` is the single apply path.

## 0.13.0

### Minor Changes

- 2c46eb5: Add structured JSON request tracing to the kb server.

  Every HTTP request gets a UUID `requestId` attached as the `x-request-id` response header and embedded in every log line for that request. Log entries are newline-delimited JSON objects on stdout, parseable by Docker, Cloud Logging, Datadog, and any other log aggregator without a sidecar.

  What gets traced:

  - **Request arrival**: method, path, client IP (proxy-aware via `x-forwarded-for`), user-agent
  - **Response completion**: status code, latency (`durationMs`) — emitted at `info`/`warn`/`error` level by status range
  - **Auth failures**: whether a key was present (not the key value), path, method
  - **`/v1/query`**: query text (truncated to 300 chars), params, and on completion: results count, answer presence, retrieval method, duration
  - **`/v1/chat`**: session ID, message text (truncated), and on completion: answer length, facts retrieved, duration; per-SSE-event detail at `debug` level
  - **`/v1/reindex`**: start, per-progress lines (`debug`), summary and duration on completion
  - **`/mcp`**: JSON-RPC method name
  - **Server startup**: port, base, LLM provider/model, MCP enabled, API key count, reindex interval
  - **Server shutdown**: signal received

  Control verbosity via `LOG_LEVEL` env var (`debug` | `info` | `warn` | `error`; default: `info`). Added to `.env.example` and `docker-compose.yml`.

## 0.12.0

### Minor Changes

- Add a getting-started path for self-hosting the kb server from the Docker image: a guided `pnpm run server:up` bootstrap (seeds `.env`, validates config, builds + boots), `server:logs`, a `packages/kb-server/README.md` deploy guide, and a test-only `mock` compose profile so real runs no longer start the WireMock sidecar.

## 0.11.0

### Minor Changes

- df35234: Add `kb server start`: HTTP API (`/v1/query`, `/v1/chat` SSE, `/healthz`, `/v1/reindex`) with optional MCP at `POST /mcp` via `--with-mcp`. `kb-server` package: Docker image, WireMock integration suite (`packages/kb-server/http/server.http`), and compose wiring.
