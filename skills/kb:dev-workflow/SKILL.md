---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I investigate via the kb MCP connector (kb_query and related
  tools) before reading files or exploring the repo — never via the kb CLI/TUI?
---

# KB dev workflow (agent skill)

## Audience split

| Who | How they talk to KB |
|-----|---------------------|
| **Agents** (this skill) | **MCP only** — `kb_query` and related MCP tools |
| **Humans** | `kb` CLI / TUI (`kb query`, chat, docs, …) |

Do **not** use the CLI/TUI as an agent investigation path. That surface is for people.

## When to use this skill

When a user gives you **any coding task**, develop an understanding of the
project (and your task) via the **kb MCP connector** **before** exploring the
codebase with grep, sed, awk, broad file reads, etc.

**ALWAYS USE THE KB MCP CONNECTOR — NEVER THE `kb` CLI/TUI TO INVESTIGATE**
**DO NOT EXCESSIVELY READ FILES**
**ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING**
**KEEP CHIT CHAT TO A MINIMUM - NO TALKY**

## Investigation = MCP connection only

Call these MCP tools. Do **not** shell out to `kb query`, `kb graph`, `kb docs`,
`kb facts`, open the TUI, or run any other `kb` subcommand to learn the codebase.

| Need | MCP tool |
|------|----------|
| Natural-language investigation | `kb_query` |
| Fact search | `kb_read_facts` |
| Symbol / code search | `kb_search_code_symbols` |
| Call-graph neighbors | `kb_get_code_neighbors` |
| Graph overview | `kb_get_code_graph_summary` |

Primary intent: **`kb_query`**.

If kb MCP tools are unavailable in this session, **stop and fix the MCP
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

The one allowed `kb` CLI use for agents is **MCP config sync** — not query:

```bash
kb mcp sync --host <host[:port]|url>
# or, with session env already set:
kb mcp sync
kb mcp status
```

That rewrites `mcpServers.kb` in `~/.cursor/mcp.json` and `~/.claude.json` to
`${server}/mcp` (Bearer from `KB_SERVER_API_KEY` when set).

If sync ran mid-session, tell the user once to **reload / reconnect MCP** so
tools appear, then call `kb_query`.

Wrong host mid-task → ask again or re-run `kb mcp sync --host …`; do not keep
querying the wrong node.
