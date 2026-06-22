---
"kb": minor
---

Add `kb server start` and `kb mcp start`: run kb as a long-lived service.

A shared, transport-agnostic service core (`src/server/kb-service.ts`) wraps the
existing query pipeline so the CLI, an HTTP API, and an MCP server all share one
code path. New surfaces:

- HTTP API (`kb server start`): `POST /v1/query` (synthesized answer for Slack and
  apps), `GET /healthz`, and `POST /v1/reindex`, with bearer-key auth via
  `KB_SERVER_API_KEY`.
- MCP server (`kb mcp start`, or `kb server start --mcp` for `POST /mcp`): exposes
  read-only retrieval tools (`kb_query`, `kb_read_facts`, code-graph helpers) over
  stdio and Streamable HTTP.
- An in-process reindex scheduler (`KB_REINDEX_INTERVAL`, default hourly) keeps the
  served index fresh via incremental rescans.
