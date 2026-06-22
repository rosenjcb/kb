# kb-server

## 0.12.0

### Minor Changes

- Add a getting-started path for self-hosting the kb server from the Docker image: a guided `pnpm run server:up` bootstrap (seeds `.env`, validates config, builds + boots), `server:logs`, a `packages/kb-server/README.md` deploy guide, and a test-only `mock` compose profile so real runs no longer start the WireMock sidecar.

## 0.11.0

### Minor Changes

- df35234: Add `kb server start`: HTTP API (`/v1/query`, `/v1/chat` SSE, `/healthz`, `/v1/reindex`) with optional MCP at `POST /mcp` via `--with-mcp`. `kb-server` package: Docker image, WireMock integration suite (`packages/kb-server/http/server.http`), and compose wiring.
