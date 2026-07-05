---
type: Spec
title: "Spec: Client ↔ Server Connection"
sources: ./server-connection.ts,./cli-global-flags.ts,./connection-error.ts,../../tests/cli/kb-api-client.test.ts,../../tests/cli/cli-global-flags.test.ts
description: Connection profile, --host override, and user-visible host/base context
tags: [spec, kb, client, connection]
timestamp: 2026-07-05T00:00:00Z
---

### Intro

HTTP wiring and connection visibility for the kb client. Architecture: [CONNECTION.md](./CONNECTION.md). Package overview: [CLIENT.md](../../CLIENT.md).

### Definitions

- **Connection profile** — resolved `ServerConnection` (`url`, optional `apiKey`, optional `base` hint).
- **Connection context** — user-facing `host: … │ base: …` or `mode: local │ base: …` string.

### Scope

## In Scope
- Host/port/URL resolution, `--host` CLI override, health probe, connection error hints
- `formatConnectionContext` for banner, TUI status bar, and chat headers

## Out of Scope
- Server-side indexing (`KB_GIT_REPOS`) — see [SERVER.md](../../../kb-server/src/SERVER.md)
- Base selection precedence — see `@kb/core/storage/base-selection.ts`

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Default remote connection resolves to `http://localhost:38117` when env unset |
| FR-2 | `KB_SERVER_URL` overrides `KB_HOST`/`KB_PORT` |
| FR-3 | `--host` accepts `host:port`, bare hostname, or full URL and overrides env for one process |
| FR-4 | Unreachable server fails fast with actionable hints including `--host` |
| FR-5 | `formatConnectionContext` shows `host:` + `base:` in remote mode and `mode: local` when `KB_LOCAL_MODE` |
| FR-6 | One-shot CLI (non-JSON stdout) prints connection context under the version banner |
| FR-7 | TUI status bar always shows host and base on one pinned row |
| FR-8 | Chat sessions print connection context before the first user prompt |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given no env overrides | `resolveServerConnection` → `http://localhost:38117` |
| TC-2 | FR-2 | Given `KB_SERVER_URL` | URL wins over host/port |
| TC-3 | FR-1 | Given `health()` | Calls `/healthz` |
| TC-4 | FR-4 | Given connection failure message | Includes `kb-server start`, `--host`, env vars |
| TC-500 | FR-3 | Given `kb --host h:38117 query …` | Strips flag; sets host env |
| TC-501 | FR-3 | Given `--host=value` | Parses inline form |
| TC-502 | FR-3 | Given bare `--host` | Throws requiring a value |
| TC-503 | FR-3 | Given `--host myhost:12345` | Sets `KB_HOST` and `KB_PORT` |
| TC-504 | FR-3 | Given `--host http://remote/` | Sets `KB_SERVER_URL` |
| TC-505 | FR-5 | Given remote config + base name | `formatConnectionContext` → `host: … │ base: …` |
| TC-506 | FR-5 | Given `KB_LOCAL_MODE` | `formatConnectionContext` → `mode: local │ base: …` |
