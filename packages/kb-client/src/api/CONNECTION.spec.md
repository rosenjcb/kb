---
type: Spec
title: "Spec: Client ↔ Server Connection"
sources: [./server-connection.ts, ./cli-global-flags.ts, ./connection-error.ts, ./mcp-config-sync.ts]
tests:
  - ../../../../tests/cli/kb-api-client.test.ts
  - ../../../../tests/cli/cli-global-flags.test.ts
  - ../../../../tests/cli/mcp-config-sync.test.ts
  - ../../../../tests/cli/remote-commands.test.ts
description: Connection profile, --host override, MCP client sync, and user-visible host/base context
tags: [spec, kb, client, connection]
timestamp: 2026-07-10T00:00:00Z
---

### Intro

HTTP wiring and connection visibility for the kb client. Architecture: [CONNECTION.md](./CONNECTION.md). Package overview: [CLIENT.md](../../CLIENT.md).

### Definitions

- **Connection profile** — resolved `ServerConnection` (`url`, optional `apiKey`, optional `base` hint).
- **Connection context** — user-facing `host: … │ base: …` or `mode: local │ base: …` string.
- **MCP endpoint** — `${connection.url}/mcp` written into agent MCP client configs.

### Scope

## In Scope
- Host/port/URL resolution, `--host` CLI override, health probe, connection error hints
- `formatConnectionContext` for banner, TUI status bar, and chat headers
- Syncing Cursor/Claude `kb` MCP entries to the resolved connection profile

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
| FR-9 | `syncKbMcpConfigs` writes Cursor + Claude `kb` entries to `${server}/mcp` from an explicit host (`--host` / `KB_SERVER_URL` / `KB_HOST` / `config.server.host`) and Bearer from env or `config.server.apiKey` |
| FR-10 | MCP sync is idempotent, preserves sibling MCP servers, no-ops under `KB_LOCAL_MODE`, returns `needs-host` instead of inventing localhost, and clears a stale Bearer when no API key is configured |
| FR-11 | `uninstallKbMcpConfigs` removes only the managed `kb` MCP entries |
| FR-12 | `readKbMcpStatus` / `kb mcp status` reports env host + current agent MCP URLs |
| FR-13 | `mcp`, `skills`, `uninstall`, `sync`, and `base use` stay client-local — never forwarded to `/v1/admin/cli` |
| FR-14 | CLI and TUI startup never call `syncKbMcpConfigs` — MCP install is opt-in via `kb mcp install` / `kb skills install` only |

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
| TC-507 | FR-9 | Given server URL with trailing slash | `resolveMcpEndpointUrl` → `…/mcp` |
| TC-508 | FR-9 | Given Cursor entry builder | url + optional Bearer header |
| TC-509 | FR-9 | Given Claude entry builder | includes `type: "http"` |
| TC-510 | FR-10 | Given no explicit host | sync returns `needs-host` (no localhost write) |
| TC-511 | FR-9 | Given `KB_SERVER_URL` | MCP URL uses that host `/mcp` |
| TC-512 | FR-10 | Given matching entry | action is skipped |
| TC-513 | FR-10 | Given stale URL + sibling server | updates `kb` only |
| TC-514 | FR-10 | Given `KB_LOCAL_MODE` | sync returns `[]` |
| TC-515 | FR-11 | Given `kb` + other servers | uninstall removes only `kb` |
| TC-516 | FR-11 | Given no `kb` entry | action is not-found |
| TC-517 | FR-9 | Given sync results | `formatMcpSyncReport` lists agents |
| TC-520 | FR-10 | Given env unset / set / `config.server.host` | `hasExplicitServerHost` false then true |
| TC-521 | FR-9 | Given `--host` with env unset | installs Cursor + Claude entries |
| TC-522 | FR-10 | Given `needs-host` result | report includes warning |
| TC-523 | FR-12 | Given no MCP files | status shows unset / missing entries |
| TC-524 | FR-13 | Given `mcp status` / `skills` / `base use` | `isClientLocalCommand` is true (not admin CLI) |
| TC-525 | FR-14 | Given bare `kb` / one-shot CLI startup | Does not call `syncKbMcpConfigs` |
| TC-626 | FR-13 | Given `query` / `docs list` | `isClientLocalCommand` is false (forwarded remotely) |
| TC-627 | FR-9 | Given only `config.server.host` + apiKey | sync installs with Bearer (no env host) |
| TC-628 | FR-10 | Given no API key but existing Bearer | sync updates and clears Authorization |
