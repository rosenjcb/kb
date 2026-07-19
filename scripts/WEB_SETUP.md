---
type: Guide
title: KB on Claude Code for the web
description: Wire every cloud session to the shared kb-server MCP endpoint via an environment setup script.
resource: ./web-setup.sh
tags: [client, mcp, claude-code-web, setup, fly]
timestamp: 2026-07-19T00:00:00Z
---

# KB on Claude Code for the web

Goal: every [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
session — on **any** repo — starts with the `kb` client installed, the kb agent
skills + "ask `kb_query` first" hook in place, and the `kb` MCP server pointed at
our shared **kb-server** so `/kb:dev-workflow` and `kb_query` work out of the box.

## The short version

1. **Server:** nothing to do. `kb-server` already serves MCP. The Fly app
   `kb-demo` starts with `kb-server start --with-mcp`
   ([`Dockerfile`](../packages/kb-server/Dockerfile)), so
   `https://kb-demo.fly.dev/mcp` is live. (Set `KB_SERVER_API_KEY` only if you
   want to lock it — see [Auth](#auth).)
2. **Environment network:** set the environment's network access to **Custom**,
   keep the default package managers, and add your server host
   (`kb-demo.fly.dev`) to **Allowed domains**. `fly.dev` is **not** in the
   default Trusted allowlist, so MCP traffic is blocked without this.
3. **Environment setup script:** paste [`web-setup.sh`](./web-setup.sh) into the
   environment's **Setup script** field. It installs Node 24 + the `kb` client
   and runs `kb skills install` against the server.

That's it. New sessions in that environment inherit the cached filesystem, so the
install runs once and every later session starts ready.

## Why an environment setup script (not repo files)

Claude Code on the web has two carryover surfaces:

| Surface | Scope | Fits "every repo"? |
|---|---|---|
| Repo `.mcp.json` / `.claude/settings.json` / `.claude/skills/` | one repo | ✗ — only the repo it's committed to |
| **Environment setup script** | every session in the environment | ✓ |

Because we want KB in sessions on arbitrary repos, the wiring belongs to the
**environment**, not to any one repo. The setup script runs as root before Claude
launches; its disk writes (the `kb` binary, `~/.claude*`) are snapshotted and
reused, so startup stays fast.

`kb skills install` writes to **user scope** in the container
([`skill-installer.ts`](../packages/kb-client/src/cli/skill-installer.ts),
[`mcp-config-sync.ts`](../packages/kb-client/src/api/mcp-config-sync.ts)):

- `~/.claude/skills/kb:*/SKILL.md` — the agent skills, incl. `kb:dev-workflow`
- `~/.claude/settings.json` — the `PreToolUse` hook nudging `kb_query` before grep
- `~/.claude.json` → `mcpServers.kb = { type: "http", url: "<server>/mcp" }`

The MCP URL follows the active connection, so `KB_SERVER_URL` in the setup script
is what aims it at Fly instead of localhost.

## Network access (required)

In the environment dialog → **Network access** → **Custom**:

- Check **Also include default list of common package managers** (npm + GitHub,
  needed to install the client from Releases).
- **Allowed domains:** add your kb-server host, one per line:

  ```text
  kb-demo.fly.dev
  ```

Without this, `kb_query` calls fail at the security proxy (you'll see a
`CONNECT tunnel failed, 403`-style block). This is *outbound-to-your-server*
allowlisting; it is unrelated to claude.ai MCP **connectors** (those tunnel
through Anthropic and don't need a domain entry).

## Auth

The `kb-demo` server runs open (`KB_SERVER_API_KEY` unset), matching
[`FLY.md`](../packages/kb-server/FLY.md). To lock it:

1. Server: `fly secrets set -a kb-demo KB_SERVER_API_KEY=<key>`.
2. Environment: add `KB_SERVER_API_KEY=<key>` as an environment variable.
   `kb skills install` reads it and writes the `Authorization: Bearer` header
   into the MCP entry.

Environment variables and setup scripts are visible to anyone who can edit the
environment — treat the key accordingly.

## Verify in a session

```bash
kb mcp status            # kb entry should read https://kb-demo.fly.dev/mcp
kb --host https://kb-demo.fly.dev query "how does base selection work?"
```

In Claude Code, `/mcp` should list the `kb` server and its `kb_query` tool, and
`/kb:dev-workflow` should be available.

### If the MCP tool doesn't appear

The one thing that can't be verified outside a live web session is whether the
cloud harness honors the container-written `~/.claude.json` `mcpServers`. If
`kb_query` is missing after the setup script ran, the fallback is repo-scoped
config on the repos you use most: commit a `.mcp.json` with the same `kb` entry
(and a `SessionStart` hook that runs `kb skills install`) into that repo's
`.claude/`. The setup script still installs the binary; the repo files just
guarantee the MCP registration for that repo.

## Notes / caveats

- **Single machine.** `kb-demo` is one Fly machine + one SQLite volume serving
  the Pages chatbot. Heavy concurrent agent `kb_query` load competes with it; if
  usage grows, run a dedicated kb-server for agent MCP traffic rather than
  overloading the demo host.
- **Setup-script budget.** Keep total setup under ~5 minutes so the environment
  cache can build. The client install + skills install is well under that; the
  Node 24 install is the slowest step and only runs if the base image lacks it.
- **Node on PATH.** The script symlinks `node` and `kb` into `/usr/local/bin`
  because the non-interactive shell Claude uses doesn't source `~/.bashrc`.
