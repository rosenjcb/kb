# kb-server

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
