---
type: Subsystem
title: KB Core
description: Shared domain — indexing, retrieval, LLM, KbService; no transport.
resource: ./packages/kb-core
tags: [core, indexing, retrieval, llm]
timestamp: 2026-07-03T00:00:00Z
---

# KB Core (`@kb/core`)

Shared brain for client (local mode) and server. Owns everything that touches the SQLite index, graph, LLM providers, and retrieval pipelines. **No HTTP, Ink, or CLI routing.**

## Role in the stack

```mermaid
flowchart TB
  Srv["kb-server http-server"]
  Cli["kb client local mode"]
  Core["@kb/core"]
  DB["KB_HOME / .kb-index.sqlite"]

  Srv --> Core
  Cli --> Core
  Core --> DB
```

## Module map

| Directory | Responsibility |
|---|---|
| `core/` | LLM, agent loop, telemetry, doc generation, publish |
| `tools/` | SQLite index, tree-sitter, graph, fact curator |
| `intents/` | Intent router, policy |
| `prompts/` | `.md` templates + loader |
| `ops/` | `init-cli`, `scan-command`, git sync |
| `query/` | Intent CLI helpers, retrieval, `chat-synthesis` |
| `service/` | `KbService`, `query-pipeline`, serialize, session store |
| `storage/` | Base selection, `meta.json`, paths |
| `config/` | `kb-config`, cmd-ref, prerequisites |
| `ui/` | `CliOutput`, `Printer`, orchestration meta (shared with client) |

## Key seams

- **`createKbService()`** (`service/kb-service.ts`) — transport-agnostic query/chat/reindex/health.
- **`runQueryPipeline()`** (`service/query-pipeline.ts`) — shared retrieval path for CLI local mode and server.
- **`runChatSynthesis()`** (`query/chat-synthesis.ts`) — multi-turn chat loop; server streams via `chat-stream.ts`.

Heavy native deps (tree-sitter, ast-grep, optional transformers) live **only here**.

## Config split

| Concern | Where |
|---|---|
| LLM keys, retrieval features | Server-side `config.json` under `KB_HOME` (local mode reads same file) |
| Client connection profile | `config.json` → `server` block (client package) |

## Invariants

- `@kb/core` must not depend on `@kb/client` or `@kb/server`.
- Domain ops (`init`, `scan`) stay in `ops/` — not in client CLI files.
- `getKbHomeDir()` / `KB_HOME` resolve all durable paths.

## Related docs

- Architecture → [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Server transport → [`../kb-server/src/SERVER.md`](../kb-server/src/SERVER.md)
- Deep dives under `packages/kb-core/src/**/*.md` — QUERY_INTERNALS, INIT, TOOLS companions
