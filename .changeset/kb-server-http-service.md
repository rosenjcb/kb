---
"kb": minor
"kb-server": minor
---

Add `kb server start`: HTTP API (`/v1/query`, `/v1/chat` SSE, `/healthz`, `/v1/reindex`) with optional MCP at `POST /mcp` via `--with-mcp`. `kb-server` package: Docker image, WireMock integration suite (`packages/kb-server/http/server.http`), and compose wiring.
