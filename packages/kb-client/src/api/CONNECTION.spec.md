---
type: Spec
title: "Spec: Client ↔ Server Connection"
sources: [./server-connection.ts, ./cli-global-flags.ts, ./connection-string.ts, ./connection-error.ts, ./mcp-config-sync.ts, ../cli/remote-commands.ts]
tests:
  - ../../../../tests/cli/kb-api-client.test.ts
  - ../../../../tests/cli/cli-global-flags.test.ts
  - ../../../../tests/cli/connection-string.test.ts
  - ../../../../tests/cli/mcp-config-sync.test.ts
  - ../../../../tests/cli/remote-commands.test.ts
description: Connection profile, --host override, MCP client sync, and user-visible host/base context
tags: [spec, kb, client, connection]
timestamp: 2026-07-26T23:00:00Z
---

### Intro

HTTP wiring and connection visibility for the kb client. Architecture: [CONNECTION.md](./CONNECTION.md). Package overview: [CLIENT.md](../../CLIENT.md).

### Definitions

- **Connection profile** — resolved `ServerConnection` (`url`, optional `apiKey`, optional `base`).
- **Connection context** — user-facing `host: … │ base: …` string.
- **Connection string** — `kb://[apikey@]host[:port]/[base][?sslmode=]` URI (libpq-modelled).
- **Base on the wire** — `connection.base` sent as the `X-KB-Base` request header.
- **MCP endpoint** — `${connection.url}/mcp` written into agent MCP client configs.

### Scope

## In Scope
- Host/port/URL resolution, `--host` CLI override, health probe, connection error hints
- `formatConnectionContext` for banner, TUI status bar, and chat headers
- Syncing Cursor/Claude/Antigravity `kb` MCP entries to the resolved connection profile
- Remote chat SSE event routing (`dispatchRemoteChatStreamEvent`)

## Out of Scope
- Server-side indexing (`KB_GIT_REPOS`) — see [SERVER.md](../../../kb-server/src/SERVER.md)
- Base selection precedence — see `@kb/core/storage/base-selection.ts`
- Chat answer presentation / Sources footer — see [CHAT_REPLY.md](../../../kb-core/src/service/CHAT_REPLY.md)

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Default remote connection resolves to `http://localhost:38117` when env unset |
| FR-2 | Bare-hostname resolution (`KB_HOST`/`KB_PORT`/`KB_SSLMODE`) and `kb://` connection-string resolution share one scheme/port inference (`buildServerUrl`, default `sslmode=prefer`: TLS for remote hosts, plaintext for loopback) — the two can never disagree for the same hostname |
| FR-3 | `--host` accepts `host:port`, bare hostname, or full URL and overrides env for one process |
| FR-4 | Unreachable server fails fast with actionable hints including `--host` |
| FR-5 | `formatConnectionContext` shows `host:` + `base:` |
| FR-6 | One-shot CLI (non-JSON stdout) prints connection context under the version banner |
| FR-7 | TUI status bar always shows host and base on one pinned row |
| FR-8 | Chat sessions print connection context before the first user prompt |
| FR-9 | `syncKbMcpConfigs` writes Cursor + Claude + Antigravity `kb` entries to `${server}/mcp` from the active connection (`--host` / `KB_CONNECTION_STRING` / `KB_HOST` / `config.server.host` / localhost default) and Bearer from env or `config.server.apiKey` |
| FR-10 | MCP sync is idempotent, preserves sibling MCP servers, defaults to localhost when no host is set (matching CLI/TUI), optionally returns `needs-host` when `requireExplicitHost` is set, and clears a stale Bearer when no API key is configured |
| FR-11 | `uninstallKbMcpConfigs` removes only the managed `kb` MCP entries |
| FR-12 | `readKbMcpStatus` / `kb mcp status` reports env host + current agent MCP URLs |
| FR-13 | `mcp`, `skills`, `uninstall`, `sync`, and `base use` stay client-local — never forwarded to `/v1/admin/cli` |
| FR-14 | CLI and TUI startup never call `syncKbMcpConfigs` — MCP install is opt-in via `kb mcp install` / `kb skills install` only |
| FR-15 | `kb mcp install --key`/`--api-key` (and the `syncKbMcpConfigs` `apiKey` option) writes the Bearer header without requiring `KB_SERVER_API_KEY` in the environment, and takes precedence over the env/config key when both are set |
| FR-16 | `parseGlobalCliFlags` strips `--base`, `--connection-string`, `--port`, `--sslmode`, and `--api-key`/`--key` (space and `=` forms) and throws on a missing value |
| FR-17 | `parseKbConnectionString` parses `kb://[apikey@]host[:port]/[base][?sslmode=]` into decomposed `{hostname, port?, sslmode, apiKey?, base?}` (plus a convenience `url`): credential from userinfo, base from path, TLS from `sslmode` (default `prefer`, loopback ⇒ http), rejecting non-`kb://` schemes and unknown `sslmode` |
| FR-18 | `applyConnectionOverrides` applies precedence `--connection-string` / `KB_CONNECTION_STRING` > `--host` > `--port` > `--sslmode` > `--api-key` > `--base` > env, expanding a connection string into `KB_HOST` / `KB_PORT` / `KB_SSLMODE` / `KB_SERVER_API_KEY` / `KB_BASE` |
| FR-19 | `resolveServerConnection` carries `base` (`KB_BASE` > `KB_ACTIVE_BASE` > `config.server.base`); `kb-api-client` sends it as `X-KB-Base` on every request |
| FR-20 | `dispatchRemoteChatStreamEvent` routes chat SSE `reasoning` to progress and `meta` to log (never both to progress) |
| FR-21 | `discoverRemoteDefaultBase` probes the server's health endpoint and returns `HealthResponse.base` for display when no base was resolved locally (no `--base`, `.kb` file, active, or default base); returns `undefined` without throwing when the server is unreachable |
| FR-22 | `applyPortCliOverride` / `applySslModeCliOverride` / `applyApiKeyCliOverride` set `KB_PORT` / `KB_SSLMODE` / `KB_SERVER_API_KEY` for this process from `--port` / `--sslmode` / `--api-key`(`--key`); `--sslmode` rejects anything other than `require`/`prefer`/`disable` |
| FR-23 | `hasExplicitConnectionOverride` (aliased as `hasExplicitServerHost`) is true when `KB_CONNECTION_STRING`, `KB_HOST`, `KB_PORT`, `KB_SSLMODE`, or `config.server.host` is explicitly set — the one canonical "explicit vs. implicit localhost default" check, shared by MCP sync instead of its own duplicated env reads |
| FR-24 | `mcp install` has no independent flag parser — `--host`/`--port`/`--sslmode`/`--api-key`/`--key`/`--base`/`--connection-string` are all global flags stripped by `parseGlobalCliFlags` before dispatch; `mcp install` itself only rejects genuinely unrecognized leftover arguments and otherwise syncs from the already-applied ambient connection |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | Given no env overrides | `resolveServerConnection` → `http://localhost:38117` |
| TC-2 | FR-2 | Given a bare remote hostname (`KB_HOST`, no `KB_SSLMODE`) | Infers `https` under default `prefer` — parity with `kb://` |
| TC-3 | FR-1 | Given `health()` | Calls `/healthz` |
| TC-4 | FR-4 | Given connection failure message | Includes `kb-server start`, `--host`, env vars |
| TC-5 | FR-3 | Given `kb --host h:38117 query …` | Strips flag; sets host env |
| TC-6 | FR-3 | Given `--host=value` | Parses inline form |
| TC-7 | FR-3 | Given bare `--host` | Throws requiring a value |
| TC-8 | FR-3 | Given `--host myhost:12345` | Sets `KB_HOST` and `KB_PORT` |
| TC-9 | FR-3 | Given `--host http://remote/` | Decomposes into `KB_HOST`/`KB_PORT`/`KB_SSLMODE` |
| TC-10 | FR-5 | Given config + base name | `formatConnectionContext` → `host: … │ base: …` |
| TC-12 | FR-9 | Given server URL with trailing slash | `resolveMcpEndpointUrl` → `…/mcp` |
| TC-13 | FR-9 | Given Cursor entry builder | url + optional Bearer header |
| TC-14 | FR-9 | Given Claude entry builder | includes `type: "http"` |
| TC-15 | FR-10 | Given no explicit host | sync installs `http://localhost:38117/mcp` |
| TC-16 | FR-9 | Given `KB_HOST`/`KB_PORT`/`KB_SSLMODE` | MCP URL uses that host `/mcp` |
| TC-17 | FR-10 | Given matching entry | action is skipped |
| TC-18 | FR-10 | Given stale URL + sibling server | updates `kb` only |
| TC-20 | FR-11 | Given `kb` + other servers | uninstall removes only `kb` |
| TC-21 | FR-11 | Given no `kb` entry | action is not-found |
| TC-22 | FR-9 | Given sync results | `formatMcpSyncReport` lists agents |
| TC-23 | FR-23 | Given env unset / `KB_HOST` / `KB_CONNECTION_STRING` / `config.server.host` | `hasExplicitServerHost` false then true |
| TC-24 | FR-9 | Given `--host` with env unset | installs Cursor + Claude + Antigravity entries |
| TC-25 | FR-10 | Given `needs-host` result | report includes warning |
| TC-26 | FR-12 | Given no MCP files | status shows unset / missing entries |
| TC-27 | FR-13 | Given `mcp status` / `skills` / `base use` | `isClientLocalCommand` is true (not admin CLI) |
| TC-28 | FR-14 | Given bare `kb` / one-shot CLI startup | Does not call `syncKbMcpConfigs` |
| TC-29 | FR-13 | Given `query` / `docs list` | `isClientLocalCommand` is false (forwarded remotely) |
| TC-30 | FR-2 | Given only `config.server.host` (bare, non-loopback) + apiKey | Infers `https` with no port (implicit 443); sync installs with Bearer |
| TC-31 | FR-10 | Given no API key but existing Bearer | sync updates and clears Authorization |
| TC-32 | FR-15 | Given `apiKey` option and env unset | writes Bearer header from the option |
| TC-33 | FR-15 | Given `apiKey` option and `KB_SERVER_API_KEY` set | option key overrides the env key |
| TC-34 | FR-17 | Given `kb://localhost:38117/raylib` | url `http://localhost:38117`, base `raylib` |
| TC-35 | FR-17 | Given a remote host under `prefer` | scheme defaults to `https` |
| TC-36 | FR-17 | Given `apikey@host` userinfo | `apiKey` parsed from userinfo |
| TC-37 | FR-17 | Given `user:secret@host` userinfo | password slot taken as `apiKey` |
| TC-38 | FR-17 | Given `?sslmode=disable` on a remote host | scheme forced to `http` |
| TC-39 | FR-17 | Given `?sslmode=require` on loopback | scheme forced to `https` |
| TC-40 | FR-17 | Given an empty path | `base` omitted |
| TC-41 | FR-17 | Given a bare plaintext remote host | defaults to the KB server port |
| TC-42 | FR-17 | Given a non-`kb://` scheme | parser throws |
| TC-43 | FR-17 | Given an unknown `sslmode` | parser throws |
| TC-44 | FR-16 | Given `--base` + `--connection-string` + args | flags stripped, args preserved |
| TC-45 | FR-16 | Given `--base=` / `--connection-string=` inline forms | values parsed |
| TC-46 | FR-16 | Given bare `--base` | throws requiring a value |
| TC-47 | FR-18 | Given a connection string | expands into `KB_HOST`/`KB_PORT`/`KB_SSLMODE`/`API_KEY`/`BASE` |
| TC-48 | FR-18 | Given connection string + `--base` | `--base` refines the base |
| TC-49 | FR-19 | Given a connection with `base` | `kb-api-client` sends `X-KB-Base` |
| TC-50 | FR-19 | Given `KB_BASE` set | `resolveServerConnection` carries it as `base` |
| TC-51 | FR-20 | Given interleaved meta + reasoning SSE events | meta → log; reasoning → progress only |
| TC-52 | FR-21 | Given no local base and a reachable server | `discoverRemoteDefaultBase` returns the server-reported `base` |
| TC-53 | FR-21 | Given no local base and an unreachable server | `discoverRemoteDefaultBase` resolves `undefined` |
| TC-54 | FR-2 | Given `KB_HOST` (remote) + `KB_SSLMODE=disable` | Forces plaintext despite the remote host |
| TC-55 | FR-2 | Given `KB_HOST` (remote) + explicit `KB_PORT` | Inferred `https` scheme keeps the explicit port |
| TC-56 | FR-16 | Given `--port`, `--sslmode`, `--api-key`, and the `--key` alias | All four stripped, both space and `=` forms |
| TC-57 | FR-2 | Given `--host https://remote:9443` | Explicit scheme forces `sslmode=require` (authoritative over `prefer`) |
| TC-58 | FR-22 | Given `applyPortCliOverride`/`applySslModeCliOverride`/`applyApiKeyCliOverride` | Each sets its env var; `sslmode` is lowercased |
| TC-59 | FR-22 | Given an unknown `--sslmode` value | `applySslModeCliOverride` throws `Invalid --sslmode value` |
| TC-60 | FR-18 | Given `--host` + `--port` + `--sslmode` + `--api-key` together | Each applies in order, later flags refining earlier ones |
| TC-61 | FR-24 | Given `kb mcp install` with zero extra args | Syncs from the already-applied ambient connection (no duplicate parser) |
| TC-62 | FR-24 | Given `kb mcp install <unrecognized-arg>` | Still throws `Unknown argument: <arg>` |
