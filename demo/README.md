---
type: Guide
title: KB Chat Demo (GitHub Pages)
description: Static browser chat UI over kb-server /v1/chat with CORS and shared Sources rules.
resource: ./index.html
tags: [demo, chat, pages, cors]
timestamp: 2026-07-18T00:00:00Z
---

# KB chat demo (GitHub Pages)

A single, dependency-free HTML page that lets anyone chat with a running
[`kb-server`](../packages/kb-server) over its HTTP API — a lightweight "try it"
surface, ChatGPT/Claude style. It's published to GitHub Pages from this folder.

Brand mark: the same `KB` ASCII banner as the TUI
([`assets/kb-ascii.txt`](../assets/kb-ascii.txt) /
[`kb-ascii.svg`](kb-ascii.svg)), kept in sync with
`WelcomeBanner.tsx` — portal blue (`#00a2ff`) letters + orange
(`#ff9a00`) chip `[█]` on the middle row.

## What it does

- Talks to `POST /v1/chat` (SSE) for a streaming, multi-turn conversation, and
  probes `GET /healthz` for the connection indicator.
- Renders the answer plus its **sources** from the same `/v1/chat` `answer.sources`
  payload Slack uses. Server-side formatting lives in
  [`@kb/core/service/chat-reply`](../packages/kb-core/src/service/chat-reply.ts)
  (`formatChatReply`); this page mirrors the same rules in-browser:
  strip index prefixes, dedupe, link to `https://github.com/rosenjcb/kb/blob/main/…`.
- Answers go through a tiny dependency-free markdown renderer (ATX headers,
  GFM pipe tables, fences, inline code, bold/italic, links, lists, paragraphs).
- While waiting, SSE `meta` (stages) and `reasoning` (model thinking) render in
  separate slots so stage heartbeats do not wipe the thinking stream.
- Server URL, optional API key, and optional base are configured in **⚙ Settings**
  and stored only in the visitor's browser (`localStorage`).

## Run it locally

Two terminals:

```bash
# 1) kb-server with CORS for the demo origin
pnpm run server:start -- --allow-origin http://localhost:8000

# 2) static page (→ http://localhost:8000/)
pnpm run demo
```

Port override: `DEMO_PORT=9000 pnpm run demo` (then match `--allow-origin`).

Or open `demo/index.html` / `npx serve demo` / `python3 -m http.server -d demo 8000`.
Default server URL in ⚙ Settings: `http://localhost:38117`.

## Connecting to a server (CORS)

The page and the server are different origins, so `kb-server` must allow the
page's origin. Start the server with the origin allow-listed:

```bash
# hosted page
kb-server start --allow-origin https://rosenjcb.github.io
# or a local dev server (same as pnpm run demo)
pnpm run server:start -- --allow-origin http://localhost:8000
# env var equivalent (comma-separated; "*" allows any origin)
KB_SERVER_ALLOWED_ORIGINS=https://rosenjcb.github.io kb-server start
```

If the server was started with `KB_SERVER_API_KEY`, enter that key in ⚙ Settings.

### Two gotchas

- **Mixed content:** a page served over HTTPS (like `*.github.io`) cannot call an
  `http://` server, except `http://localhost` / `http://127.0.0.1`. To reach a
  remote server from the hosted page, put it behind HTTPS.
- **CORS:** without a matching `--allow-origin`, the browser blocks the request
  and the page shows a connection error naming the exact flag to add.

## Deployment

`.github/workflows/pages.yml` publishes this folder on every push to `main` that
touches `demo/`. One-time repo setup: **Settings → Pages → Source = "GitHub
Actions"**.

## Related docs

- Shared formatter → [`../packages/kb-core/src/service/CHAT_REPLY.md`](../packages/kb-core/src/service/CHAT_REPLY.md)
- Server CORS / Slack → [`../packages/kb-server/src/SERVER.md`](../packages/kb-server/src/SERVER.md)
- Chat turn design → [`../packages/kb-core/src/core/CHAT.md`](../packages/kb-core/src/core/CHAT.md)
