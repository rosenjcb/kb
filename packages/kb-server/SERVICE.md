---
type: Guide
title: Run kb-server as a native background service
description: Manage kb-server as a daemon — start/stop/status/restart, and install it as a launchd (macOS) / systemd (Linux) service, Postgres-style.
tags: [server, daemon, service, launchd, systemd, self-host, getting-started]
timestamp: 2026-07-10T00:00:00Z
---

# kb-server — run it as a native service

`kb-server` is a long-lived HTTP + MCP daemon. This guide covers running it as a
managed background service on your own machine — no Docker, no `package.json`.
It's the native equivalent of the Docker path in [`README.md`](./README.md):
index once, then let humans, apps, and agents query over HTTP/MCP.

There are two layers, mirroring how you'd run Postgres:

- **A managed process** — `start -d` / `stop` / `status` / `restart`, backed by a
  pid file. Good for a quick background daemon you control by hand.
- **An OS service** — `service install` registers kb-server with launchd (macOS)
  or systemd `--user` (Linux) so it starts on login and restarts on failure.

## TL;DR

```bash
kb-server init                       # ensure ~/.kb dirs + config, print next steps
export KB_SERVER_API_KEY=<token>     # bearer for /v1 and /mcp
export GEMINI_API_KEY=<key>          # or ANTHROPIC_API_KEY / OPENAI_API_KEY

kb-server service install            # launchd/systemd, starts now + on login
curl http://localhost:38117/healthz  # {"ok":true,...}
```

Prefer not to register a service? Run a one-off background daemon instead:

```bash
kb-server start -d                   # detach, return the shell
kb-server status
kb-server stop
```

## First run: `kb-server init`

```bash
kb-server init
```

Ensures `~/.kb/{run,logs,state}` and materializes the reserved `default` base
(an empty, fully-migrated index — no repos yet), then prints the next steps.
Idempotent — safe to re-run. Everything lives under `KB_HOME` (default
`~/.kb`; override by exporting `KB_HOME`). Not a prerequisite: `kb-server
start` on a completely fresh `KB_HOME` self-heals to the same `default` base
without `init` ever having run.

A base with no repos cannot answer queries. Attach at least one remote, then start:

```bash
export GEMINI_API_KEY=<key>            # or OPENAI_API_KEY / ANTHROPIC_API_KEY
export KB_SERVER_API_KEY=<strong-token>
kb-server base add-repo --base default --git https://github.com/acme/auth
kb-server start --with-mcp             # or: kb-server start -d --with-mcp
```

Use server-scoped env names (`KB_SERVER_BASE_NAME`, `KB_SERVER_BASE_GIT_REPOS`) for the daemon — not client `KB_BASE` / `KB_GIT_REPOS`.


## Configuration

kb-server is configured through environment variables (same names as the Docker
guide). The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `KB_SERVER_API_KEY` | **yes** | Bearer token(s) for `/v1/*` and `/mcp`. Empty ⇒ unauthenticated (logs a warning). |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | **one** | LLM provider for answer synthesis. |
| `KB_SERVER_BASE_NAME` | recommended | Base to build + serve. Defaults to `default`. |
| `KB_SERVER_BASE_GIT_REPOS` | first boot | `url[#branch]` list to index on an empty base. |
| `KB_REINDEX_INTERVAL` | no | Reindex cadence (`1h`, `30m`, `0` to disable). |
| `KB_HOME` | no | Data dir (default `~/.kb`). |
| `PORT` | no | Listen port (default `38117`). |

Full reference: [`README.md`](./README.md#configuration).

> **Secrets and the service manager.** A launchd/systemd unit installed by
> `service install` carries only `KB_HOME` — **not** your secrets. Put
> `KB_SERVER_API_KEY` and the provider key in the service environment: a
> launchd `EnvironmentVariables` entry, or a systemd drop-in
> (`systemctl --user edit kb-server.service`). Never commit secrets.

## Managed process (pid-file daemon)

```bash
kb-server start -d      # start detached; pid → ~/.kb/run/kb-server.pid
kb-server status        # running? pid, port, base, version, index state
kb-server restart       # stop, then start -d
kb-server stop          # SIGTERM, then SIGKILL if it doesn't exit
```

`start -d` re-spawns the server detached, waits for `/healthz`, then returns your
shell. The server owns the pid file (written when it starts listening, removed on
shutdown), so `stop`/`status` work whether it was started with `-d`, in the
foreground (`kb-server start`), or by `pnpm run server:start`. Logs stream to
`~/.kb/logs/kb-server.{out,err}.log`.

Local dev has thin wrappers around the same lifecycle:

```bash
pnpm run server:start    # background daemon (via tsx), returns the shell
pnpm run server:status
pnpm run server:stop
```

## OS service (launchd / systemd)

```bash
kb-server service install              # write the unit AND start/enable it
kb-server service install --no-start   # only write the unit; start it yourself
kb-server service status               # is it installed / running?
kb-server service uninstall            # unload + remove the unit
```

(`kb-server install` is a back-compat alias for `kb-server service install`.)

### macOS (launchd)

`service install` writes `~/Library/LaunchAgents/com.kb.server.plist` and loads
it with `launchctl load -w` (RunAtLoad + KeepAlive → starts on login, restarts on
crash). stdout/stderr go to `~/.kb/logs`. Manage it directly if you prefer:

```bash
launchctl load -w  ~/Library/LaunchAgents/com.kb.server.plist
launchctl unload -w ~/Library/LaunchAgents/com.kb.server.plist
```

### Linux (systemd --user)

`service install` writes `~/.config/systemd/user/kb-server.service`, runs
`systemctl --user daemon-reload`, and `enable --now` (starts now + on login;
`Restart=on-failure`). For start at boot without an active login session:

```bash
loginctl enable-linger "$USER"
```

Manage it directly:

```bash
systemctl --user status  kb-server.service
journalctl --user -u kb-server.service -f
systemctl --user disable --now kb-server.service
```

## Verify

```bash
curl http://localhost:38117/healthz        # always 200 when up; ok:true once the index is ready
curl -s http://localhost:38117/v1/query \
  -H "Authorization: Bearer $KB_SERVER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"how does auth work?"}'
```

MCP clients connect at `POST /mcp` with the same bearer token — the service is
started with `--with-mcp`. Wiring for Claude Code / Cursor: [`src/SERVER.md`](src/SERVER.md).

## Notes

- **Single writer.** One instance owns the SQLite index; don't run two against
  the same `KB_HOME`.
- **First boot is slow.** Cloning + indexing takes a while; `/healthz` stays
  HTTP 200 with `indexing: true` / `ok: false`, and query/MCP calls return `503`
  until the first build lands.
- **Prefer Docker?** See [`README.md`](./README.md) for the containerized path.

## Related docs

- [`README.md`](./README.md) — Docker / self-host path
- [`src/SERVER.md`](src/SERVER.md) — server internals, endpoints, MCP clients
- [`HANDOFF.md`](HANDOFF.md) — build-once, serve-many snapshot handoff
