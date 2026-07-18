# KB chat demo (GitHub Pages)

A single, dependency-free HTML page that lets anyone chat with a running
[`kb-server`](../packages/kb-server) over its HTTP API — a lightweight "try it"
surface, ChatGPT/Claude style. It's published to GitHub Pages from this folder.

## What it does

- Talks to `POST /v1/chat` (SSE) for a streaming, multi-turn conversation, and
  probes `GET /healthz` for the connection indicator.
- Renders the answer plus its **sources** (files/facts the answer is pinned to).
- Server URL, optional API key, and optional base are configured in **⚙ Settings**
  and stored only in the visitor's browser (`localStorage`).

## Run it locally

Open `demo/index.html` in a browser, or serve the folder:

```bash
npx serve demo        # or: python3 -m http.server -d demo 8000
```

Then set the server URL in ⚙ Settings (default `http://localhost:38117`).

## Connecting to a server (CORS)

The page and the server are different origins, so `kb-server` must allow the
page's origin. Start the server with the origin allow-listed:

```bash
# hosted page
kb-server start --allow-origin https://rosenjcb.github.io
# or a local dev server
kb-server start --allow-origin http://localhost:8000
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
