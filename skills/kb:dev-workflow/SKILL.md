---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I run kb query (or MCP kb_query when the kb MCP server is up)
  to understand the codebase before reading files or exploring the repo?
---

# KB dev workflow (agent skill)

## When to use this skill

When a user gives you **any coding task**, develop an understanding of the
project (and your task) via KB **before** exploring the codebase with grep,
sed, awk, broad file reads, etc.

**DO NOT EXCESSIVELY READ FILES**
**ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING**
**KEEP CHIT CHAT TO A MINIMUM - NO TALKY**

## Prefer MCP when the kb server is connected

If this session has a live **kb** MCP server (tools like `kb_query`,
`kb_read_facts`, `kb_search_code_symbols`, `kb_get_code_neighbors`,
`kb_get_code_graph_summary`), **use those tools first**. Do not shell out to
`kb query` / `kb graph` / `kb docs` when the equivalent MCP tool is available.

| Need | MCP tool (preferred) | CLI fallback |
|------|----------------------|--------------|
| Natural-language investigation | `kb_query` | `kb query` |
| Fact search | `kb_read_facts` | `kb facts` |
| Symbol / code search | `kb_search_code_symbols` | `kb query` / graph |
| Call-graph neighbors | `kb_get_code_neighbors` | `kb graph` |
| Graph overview | `kb_get_code_graph_summary` | `kb graph` |
| Markdown / docs browse | (CLI) | `kb docs` |

Primary intent: **`kb_query`** (MCP) or **`kb query`** (CLI).

Backup surfaces: graph + docs (`kb graph` / `kb docs`, or MCP graph tools).

If MCP is missing/broken **and** the `kb` CLI is missing or has no base/LLM
configured, say so once and continue without pretending you ran commands.

## MCP must target the same node as the CLI

The kb MCP URL must match the client connection profile (`KB_SERVER_URL` or
`KB_HOST`/`KB_PORT`, plus `KB_SERVER_API_KEY`). `kb skills install` (and normal
`kb` startup) rewrites the `kb` entry in `~/.cursor/mcp.json` and
`~/.claude.json` to `${server}/mcp`. If tools hit the wrong host, re-run
`kb skills install` or fix those env vars — do not invent a different URL.
