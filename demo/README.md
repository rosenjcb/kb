---
type: Guide
title: KB Chat Demo (GitHub Pages)
description: Static browser chat UI over kb-server /v1/chat with CORS and Slack-like bootstrap wait.
resource: ./index.html
tags: [demo, chat, pages, cors, fly]
timestamp: 2026-07-18T00:00:00Z
---

# KB chat demo (GitHub Pages)

Dependency-free HTML “try it” surface — ChatGPT-style chat against a running
[`kb-server`](../packages/kb-server) over `POST /v1/chat` (SSE). Published from
this folder via [GitHub Pages](https://rosenjcb.github.io/kb/) (workflow
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml)).

Hosted backend for this demo: Fly app **`kb-demo`** →
`https://kb-demo.fly.dev` ([`../packages/kb-server/FLY.md`](../packages/kb-server/FLY.md)).
Slack is **not** enabled on that host.

Brand mark: same `KB` ASCII as the TUI
([`assets/kb-ascii.txt`](../assets/kb-ascii.txt) /
[`kb-ascii.svg`](kb-ascii.svg)) — portal blue `#00a2ff` + orange `#ff9a00` chip.

## Role in the stack

```mermaid
sequenceDiagram
  participant U as Browser demo/
  participant S as kb-server
  U->>S: GET /healthz
  alt first-boot indexing
    S-->>U: 200 + indexing + progress
    U->>U: pill polls; chat waits
    U->>S: GET /healthz until ok
  end
  U->>S: POST /v1/chat SSE
  S-->>U: meta / reasoning / answer+sources
```

## What it does

- Streams `POST /v1/chat`; connection pill probes `GET /healthz` body flags
  (`ok` / `indexing` / `reindexing` — HTTP status is always 200 when reachable).
- **First-boot:** pill shows progress; a sent message waits (Slack-shaped:
  notice → poll until ready → one retry) then answers. The **daily scheduler
  reindex** keeps serving the existing index (chat stays up).
- **Base picker** in the header (order: status · base · theme) lists
  every base the server advertises on `GET /v1/bases` and sends the choice as
  `X-KB-Base`. The connected server is **baked into the page** (`config.js` →
  `window.__KB_SERVER__`), never typed in.
- Sources from `answer.sources` (same payload Slack uses). Blob links are
  **per base**: each source's `gitRepo` slug → the browse `url`/`branch` the
  server returns for the selected base in `/v1/bases`.
- Tiny markdown renderer (headers, tables, fences, lists, …).
- SSE `meta` (stages) and `reasoning` stay in separate slots.
- **No settings dialog.** The server URL and the optional API key are both baked
  into `config.js` (`window.__KB_SERVER__` / `window.__KB_API_KEY__`). The API
  key is empty for the open public demo; bake in the matching key only if the
  server sets `KB_SERVER_API_KEY`. The selected base is remembered in
  `localStorage`.
- Header brand click starts a **new chat** (clears thread + server `sessionId`;
  theme/base stay). Modified-click still opens a fresh page via `href="./"`.
- Empty-state suggestion chips are **per base**: each base gets a hard-coded pack
  drawn from that repo's eval suite question set
  ([`eval/suites/<base>.yaml`](../eval/suites/), e.g. `demo` → `kb.yaml`), so
  swapping the base swaps the starter questions. Bases without a dedicated pack
  fall back to the repo-neutral
  [`eval/suites/generic.yaml`](../eval/suites/generic.yaml) set.

## Run it locally

```bash
# 1) kb-server with CORS for the demo origin
pnpm run server:start -- --allow-origin http://localhost:8000

# 2) static page → http://localhost:8000/
pnpm run demo
```

Port override: `DEMO_PORT=9000 pnpm run demo` (match `--allow-origin`).

The server URL is baked in `config.js` (`window.__KB_SERVER__`), not a setting:
- `pnpm run demo` on localhost → `http://localhost:38117` (when `config.js` still
  holds the Fly default, local dev auto-targets localhost)
- GitHub Pages → the baked `https://kb-demo.fly.dev` (API key blank; open demo).
  Override per-deploy with the `KB_DEMO_SERVER_URL` repo variable (the Pages
  workflow rewrites `config.js` from it).

## CORS + auth

```bash
KB_SERVER_ALLOWED_ORIGINS=https://rosenjcb.github.io,http://localhost:8000
```

- HTTPS Pages cannot call `http://` remotes (mixed content) — use Fly HTTPS.
- Empty server `KB_SERVER_API_KEY` ⇒ open chat (demo default). Non-empty ⇒ bake
  the matching key into `config.js` (`window.__KB_API_KEY__`); the Pages workflow
  can inject it from the `KB_DEMO_API_KEY` secret.

## Deployment

- **Pages:** push to `main` touching `demo/` → Actions deploy. Repo setting:
  Pages → Source = **GitHub Actions**.
- **API:** see [`../packages/kb-server/FLY.md`](../packages/kb-server/FLY.md).

## Invariants

- No bundler / npm deps in this folder — keep `index.html` self-contained.
- Bootstrap wait is **client-side**; chat 503 + `status: indexing` during
  first-boot; `/healthz` stays 200 with `indexing: true` in the body.
- Do not assume Slack is on the same host as the public demo.

## Related docs

- Server CORS / bootstrap vs reindex → [`../packages/kb-server/src/SERVER.md`](../packages/kb-server/src/SERVER.md)
- Spec → [`../packages/kb-server/src/SERVER.spec.md`](../packages/kb-server/src/SERVER.spec.md) (FR-16/17)
- Fly → [`../packages/kb-server/FLY.md`](../packages/kb-server/FLY.md)
- Shared formatter → [`../packages/kb-core/src/service/CHAT_REPLY.md`](../packages/kb-core/src/service/CHAT_REPLY.md)
- Chat design → [`../packages/kb-core/src/core/CHAT.md`](../packages/kb-core/src/core/CHAT.md)
