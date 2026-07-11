---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I investigate by asking the kb MCP connector (kb_query) a direct
  question before reading files or exploring the repo — never via the kb CLI/TUI?
---

# KB dev workflow (agent skill)

## Audience split

| Who | How they talk to KB |
|-----|---------------------|
| **Agents** (this skill) | **MCP only** — the `kb_query` tool |
| **Humans** | `kb` CLI / TUI (`kb query`, chat, docs, …) |

Do **not** use the CLI/TUI as an agent investigation path. That surface is for people.

## The model: KB is another agent you talk to

`kb_query` is an **agent-to-agent conversation**. You (the coding agent) ask the
knowledge-base agent a **direct question in plain terms**, and it answers you
directly — a synthesized answer, plus the **source files** that answer is drawn
from so you know exactly what to open next. It is not a search index that dumps
facts for you to sift; ask for what you actually want.

```
You:  "Where are the language parsers for AST stored?"
KB:   "In src/ast/langs/… — one module per language, registered in …"
      evidence: src/ast/langs/typescript.ts, src/ast/registry.ts
```

Then read only the files it points you at. Don't blast broad greps or read whole
trees "to be sure" — ask a sharper question instead.

## When to use this skill

When a user gives you **any coding task**, develop an understanding of the
project (and your task) by **asking `kb_query`** **before** exploring the
codebase with grep, sed, awk, broad file reads, etc.

**ALWAYS ASK `kb_query` FIRST — NEVER THE `kb` CLI/TUI TO INVESTIGATE**
**ASK A DIRECT QUESTION; READ ONLY THE FILES IT CITES**
**ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING**
**KEEP CHIT CHAT TO A MINIMUM - NO TALKY**

## Investigation = the `kb_query` MCP tool

Ask `kb_query` a natural-language question. Do **not** shell out to `kb query`,
`kb graph`, `kb docs`, `kb facts`, open the TUI, or run any other `kb` subcommand
to learn the codebase.

The response is answer-first: a direct answer with **source file** evidence.
Follow those `filePath`s to read the exact code, rather than searching blind.

If the `kb_query` MCP tool is unavailable in this session, **stop and fix the MCP
connection** (below). Do not switch to the CLI/TUI. Do not pretend you queried KB.

## Host must be explicit (local or remote)

The MCP `kb` server may be **localhost** or a **remote node**. Never invent a
host. Resolve the target in this order:

1. **Already connected** — kb MCP tools are listed/callable in this session →
   use them. Host is whatever the agent MCP config already points at.
2. **Session env** — `KB_SERVER_URL` (full URL) or `KB_HOST` (+ optional
   `KB_PORT`, default `38117`), plus `KB_SERVER_API_KEY` when the server
   requires auth. Endpoint is `${KB_SERVER_URL|http://$KB_HOST:$KB_PORT}/mcp`.
3. **Ask the user** — one short question: which kb-server?
   - local: `http://localhost:38117` (or `localhost:38117`)
   - remote: full URL, e.g. `https://kb.example.com:38117`
   Then point MCP at that host (next section) before investigating.

Do not assume localhost when env is unset and the user has not confirmed.

## Point MCP at that host (setup only)

The one allowed `kb` CLI use for agents is **MCP config install** — not query:

```bash
kb mcp install --host <host[:port]|url>
# or, with session env already set:
kb mcp install
kb mcp status
```

That rewrites `mcpServers.kb` in `~/.cursor/mcp.json` and `~/.claude.json` to
`${server}/mcp` (Bearer from `KB_SERVER_API_KEY` when set).

If install ran mid-session, tell the user once to **reload / reconnect MCP** so
tools appear, then call `kb_query`.

Wrong host mid-task → ask again or re-run `kb mcp install --host …`; do not keep
querying the wrong node.
