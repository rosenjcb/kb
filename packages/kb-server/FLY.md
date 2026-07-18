---
type: Guide
title: Deploy kb-server on Fly.io
description: Host kb-server on Fly with the monorepo Dockerfile, a /data volume, and secrets.
resource: ../../fly.toml
tags: [server, fly, deploy, docker]
timestamp: 2026-07-18T00:00:00Z
---

# Deploy kb-server on Fly.io

The Fly app [`kb-demo`](https://fly.io/apps/kb-demo) is the **backend for the
GitHub Pages chatbot** (`demo/`) only — not Slack. Do not set Slack secrets on
this app for now.

It builds from the repo-root [`fly.toml`](../../fly.toml), which points at
[`Dockerfile`](./Dockerfile) (build context = monorepo root). That is why a bare
Fly “launch from GitHub” failed with “Could not find a Dockerfile” — there is no
Dockerfile at the root; the config file tells Fly where it is.

**Single writer:** one machine + one volume. Do not scale to multiple machines
against the same SQLite volume.

## Prerequisites

- [`flyctl`](https://fly.io/docs/flyctl/install/) installed and `fly auth login`
- App name already created (or create with `fly apps create kb-demo`)
- An LLM key (`GEMINI_API_KEY` / etc.)
- **API key:** leave unset for the public Pages demo (chatbot Settings leaves
  the key blank; server allows open access when `KB_SERVER_API_KEY` is empty).
  Set a real key later if you want to lock query/chat.

## One-time volume

```bash
fly volumes create kb_data --region ams --size 5 --app kb-demo
```

Mount is declared in `fly.toml` as `kb_data` → `/data` (`KB_HOME`).

## Secrets

Never commit these. Minimum for the open demo:

```bash
fly secrets set -a kb-demo GEMINI_API_KEY=...
# do not set KB_SERVER_API_KEY — demo + /healthz work without it
```

If a key was set earlier and you want open access again:

```bash
fly secrets unset KB_SERVER_API_KEY -a kb-demo
```

To lock query/chat later (still chatbot-only):

```bash
fly secrets set -a kb-demo KB_SERVER_API_KEY=...
```

Non-secret defaults live in `fly.toml` `[env]` (`KB_BASE`, `KB_GIT_REPOS`,
CORS for Pages, reindex interval). Override with more `fly secrets set` or edit
`[env]` and redeploy.

## Deploy

From the **repo root** (not `packages/kb-server`):

```bash
fly deploy -a kb-demo
fly logs -a kb-demo          # watch first-boot clone + index
curl -sS https://kb-demo.fly.dev/healthz
```

Prefer CLI `fly deploy` over Fly UI “launch propose” if the UI still ignores
`fly.toml`. After `fly.toml` is on the branch Fly’s GitHub integration should
build with the configured Dockerfile path.

First boot clones `KB_GIT_REPOS` and indexes into the volume. `/healthz` may
report `indexing: true` / `503` on query until the index is ready; the HTTP
check grace period is 5 minutes.

## Wire clients

| Client | Setting |
|--------|---------|
| Pages demo (`demo/`) | Settings → server URL `https://kb-demo.fly.dev`; leave API key blank (unless you set one). CORS allow-lists `https://rosenjcb.github.io`. |
| `kb` CLI / MCP | optional; `--host https://kb-demo.fly.dev` or `KB_SERVER_URL=https://kb-demo.fly.dev` |

Slack stays off this host — run a separate server if you need Events later.

## Operate

```bash
fly status -a kb-demo
fly logs -a kb-demo
fly ssh console -a kb-demo
# On-demand reindex (no Authorization header if API key unset):
curl -X POST https://kb-demo.fly.dev/v1/reindex
```


Scale memory later if needed: `fly scale memory 4096 -a kb-demo`.

## Related docs

- Docker / Compose getting started → [`README.md`](./README.md)
- Server endpoints → [`src/SERVER.md`](./src/SERVER.md)
- Root config → [`../../fly.toml`](../../fly.toml)
