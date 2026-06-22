---
type: Guide
title: kb-slack — Slack bot for your KB
description: A Slack Events API bot that answers @kb mentions by calling a kb-server /v1/query.
resource: ./src/index.mjs
tags: [slack, bot, server, docker, events-api, getting-started]
timestamp: 2026-06-22T00:00:00Z
---

# kb-slack — answer `@kb` in Slack from your KB

A thin bridge: it receives Slack **Events API** webhooks, and when someone writes
`@kb <question>` it calls a running **kb-server**'s `POST /v1/query` and posts the
synthesized answer back in-thread. The bot holds no index and no LLM key — it just needs to
reach a kb-server (`KB_SERVER_URL`) with that server's bearer key.

```
Slack  ──app_mention──►  kb-slack  ──POST /v1/query (Bearer)──►  kb-server
  ▲                                                                  │
  └──────────────── chat.postMessage (answer + sources) ◄───────────┘
```

> Prerequisite: a reachable kb-server. Stand one up first — see
> [`../kb-server/README.md`](../kb-server/README.md).

## 1. Create the Slack app

Easiest is the **app manifest**: <https://api.slack.com/apps> → *Create New App* → *From a
manifest*, pick your workspace, paste this (swap the Request URL — see step 2), create:

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
      - app_mentions:read   # see the @kb mentions
      - chat:write          # post answers
settings:
  event_subscriptions:
    request_url: https://YOUR_PUBLIC_HOST/slack/events
    bot_events:
      - app_mention
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

When you save the Request URL, Slack sends a one-time `url_verification` challenge — the bot
answers it automatically, so the URL must be live **before** you save it (start the bot in
step 4 first, or save again after).

## 3. Configure

The bot reads its config from env. With Docker Compose these come from the **repo-root
`.env`** (the same file kb-server uses); `.env.example` here lists the bot-specific keys.

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | **yes** | Verify requests really came from Slack. |
| `SLACK_BOT_TOKEN` | **yes** | `xoxb-…` token to post replies. |
| `KB_SERVER_API_KEY` | **yes** | Bearer key for kb-server `/v1/query` (must match the server). |
| `KB_SERVER_URL` | no | kb-server base URL (default `http://kb-server:8080`, the compose service). |
| `PORT` | no | Port the bot listens on (default `3000`). |
| `SLACK_EVENTS_PATH` | no | Webhook path (default `/slack/events`); must match the Request URL. |

## 4. Run it

Alongside the server, on the shared compose network (the bot resolves `kb-server` by name):

```bash
pnpm run slack:up      # build + start the kb-slack container (also starts kb-server)
pnpm run slack:logs    # watch it; look for "kb-slack listening on :3000"
pnpm run slack:stop
```

Standalone (image already built, pointing at any kb-server):

```bash
docker run -d --name kb-slack -p 3000:3000 \
  -e SLACK_SIGNING_SECRET=… \
  -e SLACK_BOT_TOKEN=xoxb-… \
  -e KB_SERVER_URL=https://kb.your-domain \
  -e KB_SERVER_API_KEY=… \
  kb-slack
```

Or without Docker (Node ≥ 24, zero dependencies):

```bash
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… \
KB_SERVER_URL=http://localhost:8080 KB_SERVER_API_KEY=… \
node packages/kb-slack/src/index.mjs
```

## 5. Use it

Invite the bot to a channel (`/invite @kb`), then mention it:

```
@kb how does authentication work?
```

It replies in a thread with the synthesized answer and up to three sources. Health check:
`curl http://localhost:3000/healthz`.

## How it works

- **Signature check.** Every request is verified against `SLACK_SIGNING_SECRET`
  (HMAC-SHA256 over the raw body) with a 5-minute replay window before anything else runs
  ([`src/verify.mjs`](src/verify.mjs)).
- **Fast ack.** Slack requires a response within 3s, so the bot acks `200` immediately and
  answers out of band. Re-deliveries (same `event_id`) are de-duplicated so a slow query
  never double-posts.
- **Mentions only.** It acts on `app_mention` events from humans (it ignores `bot_id`
  messages, including itself, to avoid loops).
- **Stateless bridge.** No index, no LLM key, no DB — all retrieval/synthesis happens in
  kb-server. Scale or restart freely.

## Security notes

- Keep `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and `KB_SERVER_API_KEY` in your secret
  store; never commit a real `.env`.
- Terminate TLS at your ingress — Slack only posts to HTTPS Request URLs.
- The bot answers anyone who can mention it in a channel it's in; scope channel membership
  to control who can query the KB.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack shows "Your URL didn't respond…" | Bot not running/reachable when you saved the Request URL, or path ≠ `SLACK_EVENTS_PATH`. |
| `401` in bot logs | `SLACK_SIGNING_SECRET` mismatch, or a proxy mutated the raw body. |
| `chat.postMessage failed: not_in_channel` | Invite the bot to the channel. |
| `kb-server responded 401` | `KB_SERVER_API_KEY` doesn't match the server's key. |
| No reply, no error | Subscribe to the `app_mention` bot event and reinstall the app. |

## Related docs

- [`../kb-server/README.md`](../kb-server/README.md) — run the kb-server it talks to
- [`../kb-server/http/HTTP.md`](../kb-server/http/HTTP.md) — the `/v1/query` contract
- [`../../src/server/SERVER.md`](../../src/server/SERVER.md) — server internals
