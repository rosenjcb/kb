---
type: Spec
title: "Spec: KB Server HTTP Integration"
sources: [./]
tests: [./server.http, ./slack.http]
description: Black-box HTTP and Slack contract tests for kb-server via httpyac
tags: [spec, http, integration]
timestamp: 2026-06-28T04:05:11Z
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
| FR-2 | Query endpoint returns synthesized answers with sources when authorized |
| FR-3 | Query rejects missing or invalid API keys |
| FR-4 | Chat endpoint streams multi-turn SSE sessions |
| FR-5 | Index stays fresh via `KB_REINDEX_INTERVAL` and/or offline `kb-server scan` |
| FR-6 | MCP Streamable HTTP exposes initialize, tools/list, and tools/call |
| FR-7 | Slack webhook verifies signatures and acks events |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | GET /health response shape | ok, base, and version.server present |
| TC-2 | FR-7 | Slack url_verification challenge | Challenge value echoed in response |
| TC-3 | FR-2 | query result shape | pass (packages/kb-server/http/server.http) |
| TC-4 | FR-2 | results is an array | pass (packages/kb-server/http/server.http) |
| TC-5 | FR-3 | status 401 without key | pass (packages/kb-server/http/server.http) |
| TC-6 | FR-4 | sse content type | pass (packages/kb-server/http/server.http) |
| TC-7 | FR-4 | sse stream has session + terminal events | pass (packages/kb-server/http/server.http) |
| TC-8 | FR-4 | answered | pass (packages/kb-server/http/server.http) |
| TC-10 | FR-6 | jsonrpc result | pass (packages/kb-server/http/server.http) |
| TC-11 | FR-6 | tools include kb_query | pass (packages/kb-server/http/server.http) |
| TC-12 | FR-6 | tool returns content | pass (packages/kb-server/http/server.http) |

### Related docs

- [HTTP.md](./HTTP.md)
- [SERVER.md](../src/SERVER.md)
- [INTEGRATION_TEST.md](../INTEGRATION_TEST.md)
