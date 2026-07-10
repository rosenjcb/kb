---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I investigate via the kb MCP connector (kb_query and related
  tools) before reading files or exploring the repo — never via the kb CLI?
---

# KB dev workflow (agent skill)

## When to use this skill

When a user gives you **any coding task**, develop an understanding of the
project (and your task) via the **kb MCP connector** **before** exploring the
codebase with grep, sed, awk, broad file reads, etc.

**ALWAYS USE THE KB MCP CONNECTOR — NEVER THE `kb` CLI FOR INVESTIGATION**
**DO NOT EXCESSIVELY READ FILES**
**ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING**
**KEEP CHIT CHAT TO A MINIMUM - NO TALKY**

## Investigation = MCP only

Use these MCP tools. Do **not** shell out to `kb query`, `kb graph`, `kb docs`,
`kb facts`, or any other `kb` subcommand to learn the codebase.

| Need | MCP tool |
|------|----------|
| Natural-language investigation | `kb_query` |
| Fact search | `kb_read_facts` |
| Symbol / code search | `kb_search_code_symbols` |
| Call-graph neighbors | `kb_get_code_neighbors` |
| Graph overview | `kb_get_code_graph_summary` |

Primary intent: **`kb_query`**.

If kb MCP tools are unavailable in this session, **stop and fix the connection**
(below). Do not fall back to the CLI. Do not pretend you queried KB.

## Host must be explicit (local or remote)

The MCP `kb` server may be **localhost** or a **remote node**. Never invent a
host. Resolve the target in this order:

1. **Already connected** — kb MCP tools are listed/callable in this session →
   use them. Host is whatever the agent MCP config already points at.
2. **Session env** — `KB_SERVER_URL` (full URL) or `KB_HOST` (+ optional
   `KB_PORT`, default `38117`), plus `KB_SERVER_API_KEY` when the server
   requires auth. Endpoint is `${KB_SERVER_URL|/http://$KB_HOST:$KB_PORT}/mcp`.
3. **Ask the user** — one short question: which kb-server?
   - local: `http://localhost:38117` (or `localhost:38117`)
   - remote: full URL, e.g. `https://kb.example.com:38117`
   Then point MCP at that host (next section) before investigating.

Do not assume localhost when env is unset and the user has not confirmed.

## Point MCP at that host

After env is set or the user names a host, sync agent MCP configs:

```bash
kb mcp sync --host <host[:port]|url>
# or, with session env already set:
kb mcp sync
```

That rewrites `mcpServers.kb` in `~/.cursor/mcp.json` and `~/.claude.json` to
`${server}/mcp` (Bearer from `KB_SERVER_API_KEY` when set). Check with
`kb mcp status`.

If sync ran mid-session, tell the user once to **reload / reconnect MCP** so
tools appear, then call `kb_query`.

Wrong host mid-task → ask again or re-run `kb mcp sync --host …`; do not keep
querying the wrong node.
