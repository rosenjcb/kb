---
type: Spec
title: "Spec: KB Client"
sources: ./,../../tests/cli/kb-api-client.test.ts
description: Behavioral specification for the kb CLI client (remote default, local escape hatch)
tags: [spec, kb, client]
timestamp: 2026-07-03T00:00:00Z
---

### Intro

Thin terminal front-end for kb. Taxonomy: [CLIENT.md](./CLIENT.md), [CLI.md](./src/cli/CLI.md).

### Scope

## In Scope
- Connection profile, HTTP SDK, full remote command routing via kb-server

## Out of Scope
- Command implementations ([`@kb/core`](../kb-core/CORE.md) + `POST /v1/admin/cli` on server)

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Default path: resolve server host/port from env and `~/.kb/config.json`; health-check via `/healthz` |
| FR-2 | When the server is unreachable, fail fast with a postgres-style hint — no silent local fallback |
| FR-3 | `KB_LOCAL_MODE=true` runs all commands in-process (tests, eval harness) |
| FR-4 | Remote mode forwards init/scan/docs/facts/graph/logs/publish/base to `POST /v1/admin/cli` |
| FR-5 | Remote query uses `POST /v1/query`; chat/TUI uses `POST /v1/chat` SSE |
| FR-6 | Client-only: `config`, `skills`, `uninstall`, `sync`, `base use` |
| FR-7 | `kb server` subcommand is not registered — daemon lifecycle is `kb-server` only |

### Test Cases

| ID | Covers | Scenario |
|------|--------|----------|
| TC-1 | FR-1 | `KBHOST`/`KBPORT` default to localhost:38117 |
| TC-2 | FR-1 | `KB_SERVER_URL` overrides host/port |
| TC-3 | FR-1 | `health()` calls `/healthz` |
| TC-4 | FR-2 | Connection errors include setup hints |
