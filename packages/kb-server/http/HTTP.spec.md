---
type: Spec
title: "Spec: KB Server HTTP Integration"
sources: [./]
tests: [./server.http, ./slack.http]
description: Black-box HTTP and Slack contract tests for kb-server via httpyac
tags: [spec, http, integration]
timestamp: 2026-08-08T19:40:00Z
---

### Intro

Black-box contract for `kb-server start`. Runbook and env: [HTTP.md](./HTTP.md). Implementation: [SERVER.md](../src/SERVER.md). Runner: [INTEGRATION_TEST.md](../INTEGRATION_TEST.md).

### Definitions

- **baseUrl** — server under test (`httpyac` env `local` / `docker`)
- **apiKey** — `KB_SERVER_API_KEY` bearer token

### Scope

## In Scope
- Structural assertions on REST, MCP, and Slack webhook responses (`server.http`, `slack.http`)

## Out of Scope
- In-process handler unit tests — see [SERVER.spec.md](../src/SERVER.spec.md)

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Health endpoint is unauthenticated liveness (HTTP 200 when reachable) with readiness in the body (`ok` / `indexing`); includes `version.server` and `indexMtime` when ready |
| FR-2 | [UPDATED] Query endpoint returns synthesized answers with lean `{path, symbols?}` sources by default; `verbose: true` opts into the full evidence dump |
| FR-3 | Query rejects missing or invalid API keys |
| FR-4 | Chat endpoint streams multi-turn SSE sessions |
| FR-5 | Index stays fresh via `KB_REINDEX_INTERVAL` and/or offline `kb-server scan` |
| FR-6 | [UPDATED] MCP Streamable HTTP exposes initialize, tools/list, and tools/call for `query` / `submit_feedback` / `get_feedback_requests` over stateful sessions (`mcp-session-id` after initialize); `submit_feedback` takes a single string `requestId` (not `requestIds[]`); responses may be JSON or SSE depending on `KB_MCP_ELICITATION` (default on → SSE) |
| FR-7 | Slack webhook verifies signatures and acks events |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-4OCI | FR-1 | GET /health response shape | ok, base, and version.server present |
| TC-U2FF | FR-7 | Slack url_verification challenge | Challenge value echoed in response |
| TC-TOEH | FR-2 | [UPDATED] lean query result shape (`sources` present; no `results`/`retrieval`) | pass (packages/kb-server/http/server.http) |
| TC-VO6E | FR-2 | [UPDATED] `verbose: true` returns `results` as an array | pass (packages/kb-server/http/server.http) |
| TC-8XQM | FR-3 | status 401 without key | pass (packages/kb-server/http/server.http) |
| TC-L6IF | FR-4 | sse content type | pass (packages/kb-server/http/server.http) |
| TC-1JJ9 | FR-4 | sse stream has session + terminal events | pass (packages/kb-server/http/server.http) |
| TC-H2UW | FR-4 | answered | pass (packages/kb-server/http/server.http) |
| TC-L2OM | FR-6 | jsonrpc result | pass (packages/kb-server/http/server.http) |
| TC-5L2H | FR-6 | tools include query | pass (packages/kb-server/http/server.http) |
| TC-RFKP | FR-6 | tool returns content | pass (packages/kb-server/http/server.http) |
| TC-EJD2 | FR-6 | tools include submit_feedback | pass (packages/kb-server/http/server.http) |
| TC-FI6S | FR-6 | submit_feedback call returns ok | pass (packages/kb-server/http/server.http) |

### Related docs

- [HTTP.md](./HTTP.md)
- [SERVER.md](../src/SERVER.md)
- [INTEGRATION_TEST.md](../INTEGRATION_TEST.md)
