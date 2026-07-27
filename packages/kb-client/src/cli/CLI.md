---
type: Subsystem
title: CLI Layer
description: kb client command router, global --host flag, and remote HTTP dispatch.
resource: ./packages/kb-client/src/cli
tags: [cli, commands, client, entrypoint]
timestamp: 2026-07-11T00:00:00Z
---

# CLI Layer (`@kb/client`)

Command-line entry and TUI launch for the **`kb`** binary. Domain logic (indexing, retrieval, synthesis) lives in **`@kb/core` on kb-server**; this package routes commands, resolves connection profile, and surfaces **host + base** to the user.

Monorepo context → [`../../CLIENT.md`](../../CLIENT.md) · Connection detail → [`../api/CONNECTION.md`](../api/CONNECTION.md).

## Client vs server

| Concern | Where it runs |
|---|---|
| Git clone + index + reindex | **kb-server** (`KB_GIT_REPOS`, `KB_REINDEX_INTERVAL`) |
| `kb query`, chat TUI | Client → HTTP → server (`/v1/query`, `/v1/chat`) |
| `kb docs`, `facts`, `graph`, … | Client → `POST /v1/admin/cli` on server |
| `kb base use`, `skills`, `sync` | Client-only (local state / release-runtime install) |

**Server daemon:** `kb-server start` (not a `kb` subcommand). **Indexing:** configure `KB_GIT_REPOS` on kb-server. **Configuration:** `KB_*` environment variables in your shell profile.

## Entry points

| Entry | File | Role |
|---|---|---|
| `kb` / `kb <command>` | `index.ts` | Parses `--host`; bare TTY `kb` → TUI |
| Global flags | `../api/cli-global-flags.ts` | `--host` → env override for this process |
| Remote ops | `remote-commands.ts` | Query, chat, admin CLI over HTTP |
| Chat REPL | `chat-cli.ts` | Local or remote synthesis loop |
| Skills | `skill-installer.ts` | Install bundled skills; MCP follows active connection |
| MCP | `../api/mcp-config-sync.ts` | `kb mcp install|status|uninstall` — point agents at local/remote node |

## Connection visibility

Before work starts (except machine JSON stdout):

1. **One-shot CLI** — banner + `formatConnectionContext` line under `🤖 KB Agent Harness`.
2. **TUI** — pinned `StatusBar` + startup notice with same string.
3. **Chat** — first assistant line: `host: … │ base: …` then prompt hint.

Telemetry: `resolveReportHost(config)` on run reports.

## Global `--host`

```bash
kb --host localhost:38117 query "…"
kb --host http://remote:38117/docs list
kb --host staging:38117          # TUI when no other args
```

Parsed in `main()` before subcommand dispatch. Equivalent to setting `KB_HOST`/`KB_PORT`/`KB_SSLMODE` for one process.

## Command style (noun → verb)

Multi-action commands use **noun then verb** (`kb facts search …`). TUI slash registry mirrors the same paths (`/facts search`).

## `CliOutput` abstraction

`runMainWithOutput(args, out, config)` accepts injected output so the TUI captures slash-command results without fighting Ink.

## Shared retrieval

`kb query` and chat always hit kb-server (`/v1/query`, `/v1/chat`). Retrieval + synthesis run server-side.

| Path | Transport |
|------|-----------|
| `kb query` | `POST /v1/query` |
| chat (bare `kb`) | `POST /v1/chat` SSE |

## Base management (client view)

```text
kb base                          # status + list (server admin CLI in remote mode)
kb base use <name>               # client-local: writes ~/.kb/state/active-base
```

The repos a base indexes come from the server's `KB_SERVER_BASE_GIT_REPOS`; ignore
patterns from `KB_SERVER_IGNORE`. There is no client-side repo/ignore CRUD.

Uninitialized base → `uninitializedBaseNotice` (points to `KB_GIT_REPOS`, not `kb init`).

## Skills, uninstall, publish

Skills and MCP client wiring are **opt-in**:

- `kb skills install` — skill files, profile readmes, hooks, and MCP for the active connection (localhost default)
- `kb mcp install --host …` — preferred for pointing Cursor/Claude at a node

CLI/TUI startup does **not** auto-install skills or rewrite MCP configs. Spec: [`CLI.spec.md`](CLI.spec.md) FR-31 · connection: [`../api/CONNECTION.md`](../api/CONNECTION.md).

## `kb sync`

`kb sync` is a release-runtime refresh, not a source build. It downloads the
published client and server tarballs from GitHub Releases, extracts them into
`~/.kb/runtime/{client,server}`, and rewires the stable `~/.kb/bin/kb` and
`~/.kb/bin/kb-server` symlinks. The managed Node 24 runtime is still required
for execution, but sync no longer shells out to `npm install`.

## kb-server (separate binary)

HTTP/MCP daemon: [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md).

## Gotchas

- **`--host` vs env:** flag wins for one invocation only; shell profile env persists.
- **Apply defaults:** TUI auto-appends `--apply` for `publish` preview — CLI users pass `--apply` explicitly.
- **Base resolution:** `@kb/core/storage/base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE`.
- **Sync layout:** release installs expect `runtime/*/bin/*` plus sibling `node_modules/`, not `node_modules/.bin/*`.
- **Help copy:** TUI hints use slash form via `cmd(name, 'tui')`; CLI uses `kb …`.

## Related docs

- Connection → [`../api/CONNECTION.md`](../api/CONNECTION.md)
- TUI → [`../tui/TUI.md`](../tui/TUI.md)
- Client package → [`../../CLIENT.md`](../../CLIENT.md)
- Behavioral spec → [`CLI.spec.md`](CLI.spec.md)
- Server indexing → [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md)
