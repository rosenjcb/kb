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
timestamp: 2026-08-19T20:45:00Z
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
| FR-17 | `parseKbConnectionString` parses `kb://[apikey@]host[:port]/[base][?sslmode=]` into decomposed `{hostname, port?, sslmode, apiKey?, base?}` (plus a convenience `url`): credential from userinfo, base from path, TLS from `sslmode` (default `prefer`, loopback ⇒ http). A schemeless `host[:port]/base` is accepted as `kb://` shorthand; a string carrying any *other* scheme (`http://…`) and unknown `sslmode` are rejected |
| FR-18 | `applyConnectionOverrides` applies precedence `--connection-string` / `KB_CONNECTION_STRING` > `--host` > `--port` > `--sslmode` > `--api-key` > `--base` > env, expanding a connection string into `KB_HOST` / `KB_PORT` / `KB_SSLMODE` / `KB_SERVER_API_KEY` / `KB_BASE` |
| FR-19 | `resolveActiveBaseName` is the **single** base resolver shared by the wire and the UI — `KB_BASE` (explicit `--base` / `--connection-string`) > active base (via `resolveEffectiveBaseDir`) > `config.server.base`. `resolveServerConnectionWithBase` puts it on the connection and `kb-api-client` sends it as `X-KB-Base`; the status bar / CLI banner / chat header display the same value, so the served base and the shown base can never drift. `resolveServerConnection` (endpoint only) carries no base. There is no client-side default base — an unset base means kb-server uses its own default |
| FR-20 | `dispatchRemoteChatStreamEvent` routes chat SSE `reasoning` to progress and `meta` to log (never both to progress) |
| FR-21 | `discoverRemoteDefaultBase` probes the server's health endpoint and returns `HealthResponse.base` for display when no base was resolved locally (no `--base` and no active base); returns `undefined` without throwing when the server is unreachable |
| FR-22 | `applyPortCliOverride` / `applySslModeCliOverride` / `applyApiKeyCliOverride` set `KB_PORT` / `KB_SSLMODE` / `KB_SERVER_API_KEY` for this process from `--port` / `--sslmode` / `--api-key`(`--key`); `--sslmode` rejects anything other than `require`/`prefer`/`disable` |
| FR-23 | `hasExplicitConnectionOverride` (aliased as `hasExplicitServerHost`) is true when `KB_CONNECTION_STRING`, `KB_HOST`, `KB_PORT`, `KB_SSLMODE`, or `config.server.host` is explicitly set — the one canonical "explicit vs. implicit localhost default" check, shared by MCP sync instead of its own duplicated env reads |
| FR-24 | `mcp install` has no independent flag parser — `--host`/`--port`/`--sslmode`/`--api-key`/`--key`/`--base`/`--connection-string` are all global flags stripped by `parseGlobalCliFlags` before dispatch; `mcp install` itself only rejects genuinely unrecognized leftover arguments and otherwise syncs from the already-applied ambient connection |
| FR-25 | `resolveDisplayBase` resolves the base to *display* (status bar / banner / chat header): the active base (`isServerDefault: false`) when one is selected, else the server's own default base via `discoverRemoteDefaultBase` (`isServerDefault: true`), or `{ name: undefined }` when the server is unreachable. `formatConnectionContext` labels the server-default case as `base: <name> (server default)`, so the client never shows a bare `(none)` while kb-server is in fact serving its default — making it obvious that with no `kb base use <base>` you are on the server default |
| FR-26 | `dispatchRemoteChatStreamEvent`'s `answer` case exposes the SSE event's grouped sources via `onSources`, so `runRemoteChatSession` renders the same Sources footer `kb query` already does (count, then one citation per file, capped at 8) instead of silently dropping citations on the chat path |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-THW7 | FR-1 | Given no env overrides | `resolveServerConnection` → `http://localhost:38117` |
| TC-V25H | FR-2 | Given a bare remote hostname (`KB_HOST`, no `KB_SSLMODE`) | Infers `https` under default `prefer` — parity with `kb://` |
| TC-JJBZ | FR-1 | Given `health()` | Calls `/healthz` |
| TC-3GYT | FR-1 | Given an older server where `/health` 404s | `health()` falls back to `/healthz` |
| TC-GNQK | FR-4 | Given connection failure message | Includes `kb-server start`, `--host`, env vars |
| TC-ZYDA | FR-3 | Given `kb --host h:38117 query …` | Strips flag; sets host env |
| TC-SI3F | FR-3 | Given `--host=value` | Parses inline form |
| TC-QJ8A | FR-3 | Given bare `--host` | Throws requiring a value |
| TC-QWHE | FR-3 | Given `--host myhost:12345` | Sets `KB_HOST` and `KB_PORT` |
| TC-4SG4 | FR-3 | Given `--host http://remote/` | Decomposes into `KB_HOST`/`KB_PORT`/`KB_SSLMODE` |
| TC-PYBW | FR-5 | Given config + base name | `formatConnectionContext` → `host: … │ base: …` |
| TC-DLOM | FR-9 | Given server URL with trailing slash | `resolveMcpEndpointUrl` → `…/mcp` |
| TC-J1S1 | FR-9 | Given Cursor entry builder | url + optional Bearer header |
| TC-KUXM | FR-9 | Given Claude entry builder | includes `type: "http"` |
| TC-SQMH | FR-10 | Given no explicit host | sync installs `http://localhost:38117/mcp` |
| TC-6ZYN | FR-10 | Given `requireExplicitHost` and only the implicit localhost default | Refuses the implicit default instead of syncing it |
| TC-41V9 | FR-9 | Given `KB_HOST`/`KB_PORT`/`KB_SSLMODE` | MCP URL uses that host `/mcp` |
| TC-QD7E | FR-10 | Given matching entry | action is skipped |
| TC-ZIAB | FR-10 | Given stale URL + sibling server | updates `kb` only |
| TC-XA0Q | FR-11 | Given `kb` + other servers | uninstall removes only `kb` |
| TC-UX51 | FR-11 | Given no `kb` entry | action is not-found |
| TC-68L8 | FR-9 | Given sync results | `formatMcpSyncReport` lists agents |
| TC-DDES | FR-23 | Given env unset / `KB_HOST` / `KB_CONNECTION_STRING` / `config.server.host` | `hasExplicitServerHost` false then true |
| TC-749M | FR-9 | Given `--host` with env unset | installs Cursor + Claude + Antigravity entries |
| TC-3WXS | FR-10 | Given `needs-host` result | report includes warning |
| TC-O4VO | FR-12 | Given no MCP files | status shows unset / missing entries |
| TC-KFYC | FR-13 | Given `mcp status` / `skills` / `base use` | `isClientLocalCommand` is true (not admin CLI) |
| TC-B09L | FR-14 | Given bare `kb` / one-shot CLI startup | Does not call `syncKbMcpConfigs` |
| TC-SD1N | FR-13 | Given `query` / `facts list` / `session` | `isClientLocalCommand` is false (forwarded remotely) |
| TC-5W7A | FR-2 | Given only `config.server.host` (bare, non-loopback) + apiKey | Infers `https` with no port (implicit 443); sync installs with Bearer |
| TC-JI78 | FR-10 | Given no API key but existing Bearer | sync updates and clears Authorization |
| TC-X5IO | FR-15 | Given `apiKey` option and env unset | writes Bearer header from the option |
| TC-UJ7R | FR-15 | Given `apiKey` option and `KB_SERVER_API_KEY` set | option key overrides the env key |
| TC-6RF5 | FR-17 | Given `kb://localhost:38117/raylib` | url `http://localhost:38117`, base `raylib` |
| TC-J38J | FR-17 | Given a remote host under `prefer` | scheme defaults to `https` |
| TC-9K70 | FR-17 | Given `apikey@host` userinfo | `apiKey` parsed from userinfo |
| TC-XT98 | FR-17 | Given `user:secret@host` userinfo | password slot taken as `apiKey` |
| TC-UAJH | FR-17 | Given `?sslmode=disable` on a remote host | scheme forced to `http` |
| TC-ACZ1 | FR-17 | Given `?sslmode=require` on loopback | scheme forced to `https` |
| TC-2ZVF | FR-17 | Given an empty path | `base` omitted |
| TC-LEKU | FR-17 | Given a bare plaintext remote host | defaults to the KB server port |
| TC-UJCF | FR-17 | Given a non-`kb://` scheme | parser throws |
| TC-TJZV | FR-17 | Given an unknown `sslmode` | parser throws |
| TC-PKFE | FR-16 | Given `--base` + `--connection-string` + args | flags stripped, args preserved |
| TC-4N6E | FR-16 | Given `--base=` / `--connection-string=` inline forms | values parsed |
| TC-0GV1 | FR-16 | Given bare `--base` | throws requiring a value |
| TC-PVC6 | FR-18 | Given a connection string | expands into `KB_HOST`/`KB_PORT`/`KB_SSLMODE`/`API_KEY`/`BASE` |
| TC-GB52 | FR-18 | Given connection string + `--base` | `--base` refines the base |
| TC-N0AI | FR-19 | Given a connection with `base` | `kb-api-client` sends `X-KB-Base` |
| TC-7VJJ | FR-19 | Given `KB_BASE` set | `resolveActiveBaseName` returns it; the endpoint resolver `resolveServerConnection` carries no base |
| TC-P6JO | FR-19 | Given `KB_BASE` set | `resolveServerConnectionWithBase` sends the same base `resolveActiveBaseName` resolves (wire == UI, no drift) |
| TC-3F7S | FR-17 | Given a schemeless `host:port/base` | parsed as `kb://` shorthand with `base` populated |
| TC-9QI3 | FR-20 | Given interleaved meta + reasoning SSE events | meta → log; reasoning → progress only |
| TC-DCY8 | FR-21 | Given no local base and a reachable server | `discoverRemoteDefaultBase` returns the server-reported `base` |
| TC-I12L | FR-21 | Given no local base and an unreachable server | `discoverRemoteDefaultBase` resolves `undefined` |
| TC-4N1R | FR-25 | Given an active base is selected | `resolveDisplayBase` returns it with `isServerDefault: false` and never probes |
| TC-MQGP | FR-25 | Given no active base and a reachable server | `resolveDisplayBase` returns the server default with `isServerDefault: true` |
| TC-PHMI | FR-25 | Given no active base and an unreachable server | `resolveDisplayBase` returns `{ name: undefined, isServerDefault: false }` |
| TC-JD2O | FR-25 | Given a server-default base | `formatConnectionContext` renders `base: <name> (server default)`; a local active base has no label |
| TC-P35U | FR-2 | Given `KB_HOST` (remote) + `KB_SSLMODE=disable` | Forces plaintext despite the remote host |
| TC-O9YH | FR-2 | Given `KB_HOST` (remote) + explicit `KB_PORT` | Inferred `https` scheme keeps the explicit port |
| TC-L9YJ | FR-16 | Given `--port`, `--sslmode`, `--api-key`, and the `--key` alias | All four stripped, both space and `=` forms |
| TC-4Y4B | FR-2 | Given `--host https://remote:9443` | Explicit scheme forces `sslmode=require` (authoritative over `prefer`) |
| TC-AYV4 | FR-22 | Given `applyPortCliOverride`/`applySslModeCliOverride`/`applyApiKeyCliOverride` | Each sets its env var; `sslmode` is lowercased |
| TC-3NVS | FR-22 | Given an unknown `--sslmode` value | `applySslModeCliOverride` throws `Invalid --sslmode value` |
| TC-DC9W | FR-18 | Given `--host` + `--port` + `--sslmode` + `--api-key` together | Each applies in order, later flags refining earlier ones |
| TC-5PBB | FR-24 | Given `kb mcp install` with zero extra args | Syncs from the already-applied ambient connection (no duplicate parser) |
| TC-HALW | FR-24 | Given `kb mcp install <unrecognized-arg>` | Still throws `Unknown argument: <arg>` |
| TC-KRYS | FR-4 | Given a 401 with a JSON error body | Message names `KB_SERVER_API_KEY` as the fix |
| TC-2QL3 | FR-4 | Given a 401 whose body is not JSON | Still returns the API-key hint |
| TC-GTHU | FR-4 | Given a non-401 server error carrying an `error` field | Passes the server message through unchanged |
| TC-XJ1F | FR-4 | Given an error body with no `error` field | Falls back to `server error (<status>)` |
| TC-4RGX | FR-26 | Given an `answer` SSE event carrying `sources: GroupedSource[]` | `onSources` is called with the same array |
