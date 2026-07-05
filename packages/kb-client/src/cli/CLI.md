---
type: Subsystem
title: CLI Layer
description: kb client command router, global --host flag, and remote HTTP dispatch.
resource: ./packages/kb-client/src/cli
tags: [cli, commands, client, entrypoint]
timestamp: 2026-07-05T00:00:00Z
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
| `kb base use`, `config`, `skills`, `sync` | Client-only (local state / install) |

**There is no `kb server` subcommand** — use `kb-server start`. **There is no `kb init` / `kb scan`** on the client — rejected with `INDEXING_SERVER_MANAGED_NOTICE`.

## Entry points

| Entry | File | Role |
|---|---|---|
| `kb` / `kb <command>` | `index.ts` | Parses `--host`; bare TTY `kb` → TUI |
| Global flags | `../api/cli-global-flags.ts` | `--host` → env override for this process |
| Remote ops | `remote-commands.ts` | Query, chat, admin CLI over HTTP |
| Chat REPL | `chat-cli.ts` | Local or remote synthesis loop |
| Skills | `skill-installer.ts` | Install bundled skills to agent homes |

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

Parsed in `main()` before subcommand dispatch. Equivalent to setting `KB_SERVER_URL` or `KB_HOST`/`KB_PORT` for one process.

## Command style (noun → verb)

Multi-action commands use **noun then verb** (`kb base repo add …`). TUI slash registry mirrors the same paths (`/base repo add`).

## `CliOutput` abstraction

`runMainWithOutput(args, out, config)` accepts injected output so the TUI captures slash-command results without fighting Ink.

## Shared retrieval

`kb query` and chat QUERY both use `runQueryTruthRetrieval()` → `@kb/core` intent loop. Remote mode runs retrieval server-side; local mode in-process when `KB_LOCAL_MODE=true`.

| Path | Synthesis |
|------|-----------|
| `kb query` | One-shot `enrichReadDocumentsAnswerWithLLM()` |
| chat (bare `kb`) | Multi-turn `runChatSynthesis()` with optional `query_kb` tool loop |

## Base management (client view)

```text
kb base                          # status + list (server admin CLI in remote mode)
kb base use <name>               # client-local: writes ~/.kb/state/active-base
kb base repo list|add|remove …   # server-side repo CRUD (indexes on server)
```

Uninitialized base → `uninitializedBaseNotice` (points to `KB_GIT_REPOS`, not `kb init`).

## Skills, uninstall, publish

Unchanged — see prior [`CLI.spec.md`](CLI.spec.md) FR/TC for skills installer, publish preview/apply, and split `kb uninstall` vs `kb-server uninstall`.

## kb-server (separate binary)

HTTP/MCP daemon: [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md).

## Gotchas

- **`--host` vs env:** flag wins for one invocation only; shell profile env persists.
- **Apply defaults:** TUI auto-appends `--apply` for `publish` preview — CLI users pass `--apply` explicitly.
- **Base resolution:** `@kb/core/storage/base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE`.
- **Help copy:** TUI hints use slash form via `cmd(name, 'tui')`; CLI uses `kb …`.

## Related docs

- Connection → [`../api/CONNECTION.md`](../api/CONNECTION.md)
- TUI → [`../tui/TUI.md`](../tui/TUI.md)
- Client package → [`../../CLIENT.md`](../../CLIENT.md)
- Behavioral spec → [`CLI.spec.md`](CLI.spec.md)
- Server indexing → [`../../../kb-server/src/SERVER.md`](../../../kb-server/src/SERVER.md)
