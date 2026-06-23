---
type: Guide
title: kb-slack — Slack bot for your KB
description: A Slack bot that answers @kb channel mentions via /v1/query and handles DMs as multi-turn /v1/chat sessions.
resource: ./src/index.ts
tags: [slack, bot, server, docker, events-api, getting-started]
timestamp: 2026-06-23T00:00:00Z
---

# kb-slack — answer `@kb` in Slack from your KB

A thin bridge built on `@slack/bolt`. It receives Slack Events API webhooks and does two things:

- **Channel `@kb` mentions** → `POST /v1/query` → synthesized answer posted in-thread.
- **Direct messages to the bot** → `POST /v1/chat` with a per-user session → multi-turn conversation with memory.

The bot holds no index and no LLM key — it just needs a running kb-server.

```
Channel:   @kb <question>  ──app_mention──►  kb-slack  ──POST /v1/query──►  kb-server
                                                 ▲                               │
                                                 └──── chat.postMessage ◄────────┘

DM:        <message>  ──message.im──►  kb-slack  ──POST /v1/chat (sessionId)──►  kb-server
                                           ▲                                          │
                                           └──────── chat.postMessage ◄───────────────┘
```

> Prerequisite: a reachable kb-server. Stand one up first — see
> [`../kb-server/README.md`](../kb-server/README.md).

## 1. Create the Slack app

Use the **app manifest**: <https://api.slack.com/apps> → *Create New App* → *From a manifest*,
pick your workspace, paste this (swap the Request URL — see step 2), create:

```yaml
display_information:
  name: KB
features:
  bot_user:
    display_name: kb
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # see @kb mentions in channels
      - chat:write          # post answers
      - im:history          # read DMs sent to the bot
      - im:read             # access DM channel metadata
settings:
  event_subscriptions:
    request_url: https://YOUR_PUBLIC_HOST/slack/events
    bot_events:
      - app_mention         # @kb in channels
      - message.im          # DMs to the bot
  socket_mode_enabled: false
```

Then **Install to Workspace**. Collect two secrets:

- **Signing Secret** — *Basic Information → App Credentials* → `SLACK_SIGNING_SECRET`
- **Bot User OAuth Token** (`xoxb-…`) — *OAuth & Permissions* → `SLACK_BOT_TOKEN`

## 2. Make the bot reachable (Request URL)

Slack must reach the bot over HTTPS at `…/slack/events`. The bot listens on `:3000`.

- **Production:** put it behind your ingress/load balancer with TLS; Request URL is
  `https://your-domain/slack/events`.
- **Local dev:** expose `:3000` with a tunnel, e.g. `ngrok http 3000`, and use the tunnel's
  HTTPS URL.

When you save the Request URL, Slack sends a one-time `url_verification` challenge — Bolt
answers it automatically, so the bot must be running *before* you save the URL (or save again
after starting it).

## 3. Configure

The bot reads its config from env. With Docker Compose these come from the **repo-root `.env`**
(the same file kb-server uses); `.env.example` here lists the bot-specific keys.

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | **yes** | Verify requests really came from Slack (handled by Bolt). |
| `SLACK_BOT_TOKEN` | **yes** | `xoxb-…` token to post replies. |
| `KB_SERVER_API_KEY` | **yes** | Bearer key for kb-server (must match the server's key). |
| `KB_SERVER_URL` | no | kb-server base URL (default `http://kb-server:8080`, the compose service). |
| `PORT` | no | Port the bot listens on (default `3000`). |
| `SLACK_EVENTS_PATH` | no | Webhook path (default `/slack/events`); must match the Request URL. |

## 4. Run it

Alongside the server, on the shared compose network:

```bash
pnpm run slack:up      # build + start the kb-slack container (also starts kb-server)
pnpm run slack:logs    # watch it; look for "kb-slack listening on :3000"
pnpm run slack:stop
```

The bot is gated behind the `slack` compose profile, so it stays out of `server:up` and the
integration suite. Raw compose needs the flag:
`docker compose -f packages/kb-server/docker-compose.yml --profile slack up -d kb-slack`.

Standalone (image already built, pointing at any kb-server):

```bash
docker run -d --name kb-slack -p 3000:3000 \
  -e SLACK_SIGNING_SECRET=… \
  -e SLACK_BOT_TOKEN=xoxb-… \
  -e KB_SERVER_URL=https://kb.your-domain \
  -e KB_SERVER_API_KEY=… \
  kb-slack
```

## 5. Use it

**Channel queries** — invite the bot to a channel (`/invite @kb`) then mention it:

```
@kb how does authentication work?
```

It replies in-thread with the synthesized answer and up to three sources.

**DM chat** — open a direct message with the bot and just talk:

```
You:  how does the session store work?
KB:   The session store is an in-memory Map keyed by session ID…

You:  what's the TTL?
KB:   Sessions expire after 30 minutes of idle time…
```

Each user gets their own conversation thread. The kb-server retains up to 8 turns of history;
sessions are lost if the server restarts (they live in-process memory).

Health check: `curl http://localhost:3000/healthz`

## How it works

- **Signature verification.** Bolt's `HTTPReceiver` verifies the `X-Slack-Signature` HMAC-SHA256
  header on every request before any event handler runs.
- **Fast ack.** Bolt acknowledges Slack's HTTP request immediately (before processing) so
  re-deliveries don't pile up, and deduplicates retries automatically.
- **Channel mentions** (`app_mention`) → `POST /v1/query` → single synthesized answer in-thread.
  Bot messages are ignored to avoid loops.
- **DMs** (`message.im`) → `POST /v1/chat` with `sessionId: slack-dm-<userId>` → multi-turn
  chat stream; the SSE `answer` event is extracted and posted back. Session memory lives on the
  kb-server (see `src/server/session-store.ts`).
- **Stateless bridge.** The bot itself holds no index, no LLM key, no DB — restart it freely.

## Security notes

- Keep `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and `KB_SERVER_API_KEY` in your secret
  store; never commit a real `.env`.
- Terminate TLS at your ingress — Slack only posts to HTTPS Request URLs.
- The bot answers anyone who can DM it or mention it in a joined channel; scope channel
  membership and DM permissions to control who can query the KB.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack shows "Your URL didn't respond…" | Bot not running/reachable, or path ≠ `SLACK_EVENTS_PATH`. |
| `401` in bot logs | `SLACK_SIGNING_SECRET` mismatch, or a proxy mutated the raw body. |
| `chat.postMessage failed: not_in_channel` | Invite the bot to the channel (`/invite @kb`). |
| `kb-server responded 401` | `KB_SERVER_API_KEY` doesn't match the server's key. |
| No reply to DMs | Ensure `im:history`, `im:read` scopes and `message.im` event are enabled; reinstall the app. |
| No reply to mentions, no error | Ensure `app_mention` bot event is subscribed; reinstall the app. |

## Related docs

- [`../kb-server/README.md`](../kb-server/README.md) — run the kb-server it talks to
- [`../kb-server/http/HTTP.md`](../kb-server/http/HTTP.md) — the `/v1/query` and `/v1/chat` contracts
- [`../../src/server/SERVER.md`](../../src/server/SERVER.md) — server internals including session store
