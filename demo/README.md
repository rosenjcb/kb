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
this folder via [GitHub Pages](https://rosenjcb.github.io) (workflow
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
    S-->>U: 503 / indexing + progress
    U->>U: pill polls; chat waits
    U->>S: GET /healthz until ready
  end
  U->>S: POST /v1/chat SSE
  S-->>U: meta / reasoning / answer+sources
```

## What it does

- Streams `POST /v1/chat`; connection pill probes `GET /healthz` (timeout +
  generation guard so “Checking…” cannot stick over a live Connected state).
- **First-boot:** pill shows progress; a sent message waits (Slack-shaped:
  notice → poll until ready → one retry) then answers. **Hourly scheduler
  reindex** keeps serving the existing index (chat stays up).
- Sources from `answer.sources` (same payload Slack uses). Page cannot see the
  volume registry, so blob links dogfood `https://github.com/rosenjcb/kb` @ `main`.
- Tiny markdown renderer (headers, tables, fences, lists, …).
- SSE `meta` (stages) and `reasoning` stay in separate slots.
- Settings (URL, optional API key, optional base) in `localStorage` only.
- Empty-state suggestion chips are copied from the dogfood pack
  [`eval/suites/kb.yaml`](../eval/suites/kb.yaml) (static for now; later each
  eval suite may map to a selectable base).

## Run it locally

```bash
# 1) kb-server with CORS for the demo origin
pnpm run server:start -- --allow-origin http://localhost:8000

# 2) static page → http://localhost:8000/
pnpm run demo
```

Port override: `DEMO_PORT=9000 pnpm run demo` (match `--allow-origin`).

Default Settings URL is **host-aware**:
- `pnpm run demo` on localhost → `http://localhost:38117`
- GitHub Pages → `https://kb-demo.fly.dev` (API key blank; open demo)

## CORS + auth

```bash
KB_SERVER_ALLOWED_ORIGINS=https://rosenjcb.github.io,http://localhost:8000
```

- HTTPS Pages cannot call `http://` remotes (mixed content) — use Fly HTTPS.
- Empty server `KB_SERVER_API_KEY` ⇒ open chat (demo default). Non-empty ⇒ enter key in Settings.

## Deployment

- **Pages:** push to `main` touching `demo/` → Actions deploy. Repo setting:
  Pages → Source = **GitHub Actions**.
- **API:** see [`../packages/kb-server/FLY.md`](../packages/kb-server/FLY.md).

## Invariants

- No bundler / npm deps in this folder — keep `index.html` self-contained.
- Bootstrap wait is **client-side**; server contract is 503 + `status: indexing`.
- Do not assume Slack is on the same host as the public demo.

## Related docs

- Server CORS / bootstrap vs reindex → [`../packages/kb-server/src/SERVER.md`](../packages/kb-server/src/SERVER.md)
- Spec → [`../packages/kb-server/src/SERVER.spec.md`](../packages/kb-server/src/SERVER.spec.md) (FR-16/17)
- Fly → [`../packages/kb-server/FLY.md`](../packages/kb-server/FLY.md)
- Shared formatter → [`../packages/kb-core/src/service/CHAT_REPLY.md`](../packages/kb-core/src/service/CHAT_REPLY.md)
- Chat design → [`../packages/kb-core/src/core/CHAT.md`](../packages/kb-core/src/core/CHAT.md)
