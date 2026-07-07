---
type: Guide
title: Run a KB Server with Docker
description: Self-host the kb HTTP/MCP server from the Docker image — getting started, config, and operations.
resource: ./docker-compose.yml
tags: [server, docker, deploy, getting-started, self-host]
timestamp: 2026-06-22T00:00:00Z
---

# kb-server — run a KB server with Docker

The same image that backs the integration suite is a **deployable server**: index your
repos once on durable storage and have humans, apps, and agents query them over HTTP/MCP
instead of running `kb init` on every machine.

This guide is the getting-started path for a **fresh, real KB**. For the test harness
see [`INTEGRATION_TEST.md`](INTEGRATION_TEST.md).

Behavioral specs: [`src/SERVER.spec.md`](src/SERVER.spec.md) (unit) · [`http/HTTP.spec.md`](http/HTTP.spec.md) (integration).

## TL;DR

```bash
pnpm run server:up      # seeds .env on first run, builds + starts the server
# → edit .env (provider key + a strong KB_SERVER_API_KEY + repos), then:
pnpm run server:up      # boots; first run clones + indexes your repos
pnpm run server:docker:logs
curl http://localhost:38117/healthz
```

## Prerequisites

- **Docker** with the Compose plugin (`docker compose version`).
- **An LLM provider key** for answer synthesis — one of `GEMINI_API_KEY`,
  `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`.
- The **git URLs** of the repos you want indexed.

## Getting started (guided)

`pnpm run server:up` is the friendly one-shot. On the **first** run it copies
`.env.example` → `.env` and stops so you can fill in secrets (it never boots with the
placeholder keys):

```bash
pnpm run server:up
```

Edit the generated `.env` at the repo root:

```ini
KB_BASE=acme                                   # the base name to serve
KB_GIT_REPOS=https://github.com/acme/auth,https://github.com/acme/web
GITHUB_TOKEN=<optional-github-token>           # optional; only needed for private GitHub repos over HTTPS
KB_SERVER_API_KEY=<a-strong-random-token>      # required to call /v1 and /mcp
GEMINI_API_KEY=<your-provider-key>             # or ANTHROPIC_API_KEY / OPENAI_API_KEY
KB_REINDEX_INTERVAL=1h
PORT=38117
```

Then run it again to build and start:

```bash
pnpm run server:up
```

`server:up` validates the config (provider key present, bearer key not the `testkey`
default, repos declared for a fresh volume), builds the image, and starts **only** the
`kb-server` service. First boot clones + indexes `KB_GIT_REPOS`; later boots reuse the
persisted index on the `/data` volume — no reindex on restart.

> `server:start` runs `kb-server start --with-mcp` locally in your shell.
> `server:up` is the guided Docker bootstrap.
> `server:docker:start|stop|logs` are Docker convenience wrappers.

## Configuration

The server is configured entirely through environment variables (read from `.env`, or the
shell, or your orchestrator's secret store). `KB_SERVER_*` names are the canonical,
server-scoped ones; the shorter aliases are kept for back-compat.

| Variable | Required | Purpose |
|---|---|---|
| `KB_SERVER_API_KEY` | **yes** | Bearer token(s) for `/v1/*` and `/mcp`; comma-separated for rotation. Empty ⇒ unauthenticated (logs a warning). |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | **one** | LLM provider for synthesis (auto-detected). |
| `GITHUB_TOKEN` (or `GH_TOKEN`) | private GitHub repos only | Optional GitHub HTTPS auth for clone/fetch. Public repos work without it; SSH remotes also work without it. |
| `KB_SERVER_BASE_NAME` (alias `KB_BASE`) | recommended | Base name to build + serve. |
| `KB_SERVER_BASE_GIT_REPOS` (alias `KB_GIT_REPOS`) | first boot | Comma/whitespace-separated `url[#branch]` list to index on an empty volume. |
| `KB_SERVER_IGNORE` | no | Comma/newline-separated gitignore-style patterns to skip while indexing (e.g. `tests/, **/*.spec.ts, vendor`). Applied on the first build and every reindex. |
| `KB_REINDEX_INTERVAL` | no | Reindex cadence: `1h`, `30m`, `10s`, or `0` to disable (default `1h`). |
| `KB_SERVER_BOOTSTRAP_POLICY` | no | `auto` (default) builds on an empty volume; `prepared-only` refuses to build and serves only pre-supplied state (see [handoff](#separate-build-from-serve-prepared-state-handoff)). |
| `KB_HOME` | no | Data dir on the mounted volume (image default `/data`). |
| `PORT` | no | Host port to expose (container always listens on `38117`). |

Secrets belong in your platform's secret store (Compose `.env` locally, Secret Manager /
Vault in production) — never commit a real `.env`.

### Per-repo branches and ignore patterns

Everything is an environment variable — these are Docker service nodes, not local
checkouts, so there is no config file to manage. Per-repo branches ride inline in the repo
list, and index-ignore patterns come from `KB_SERVER_IGNORE`:

```ini
KB_SERVER_BASE_GIT_REPOS=https://github.com/acme/auth#main, https://github.com/acme/web#develop
KB_SERVER_IGNORE=**/node_modules/**, **/*.test.ts
```

Precedence (highest wins): `--git` flags → `KB_SERVER_BASE_GIT_REPOS` / `KB_GIT_REPOS`
env. Repos added to the env list later are folded in on the next boot without a manual
reindex.

For private GitHub repos, keep `KB_GIT_REPOS` as plain `https://github.com/...` URLs and
set `GITHUB_TOKEN` (or `GH_TOKEN`) separately. The server forwards the token to `git`
through an in-memory auth header, so cloned repos do not need tokenized remotes.

### Separate build from serve (prepared-state handoff)

When the initial index build is much heavier than steady-state serving, build once on
a big worker and serve from a small one. The prepared state is a portable bundle
(a directory + a `kb-prepared.json` manifest); ship it by any transport.

```bash
# On the builder (large machine / CI job), after the index is built:
kb-server export --base acme --out ./acme.kb           # serve-only bundle (small)
tar czf acme.kb.tgz -C ./acme.kb .

# On the serving worker (small machine / slim image):
tar xzf acme.kb.tgz -C ./incoming
kb-server import --from ./incoming --base acme          # verifies digest + compat
kb-server start --base acme --bootstrap-policy prepared-only
```

`prepared-only` guarantees the serving worker never does builder-sized work: with no
index it reports `503` + a `bootstrapError` on `/healthz` instead of rebuilding. Add
`--with-repos` to `export` if the consumer should also be able to `POST /v1/reindex`.
Full model → [`HANDOFF.md`](./HANDOFF.md).

## Without pnpm — raw Docker

The Docker scripts are thin wrappers; if you already have the image (built or pulled) and
don't want pnpm, drive Docker directly. Both paths read the same env.

### Raw `docker compose`

Run from the **repo root** so the `.env` is picked up. These are exactly what the npm
scripts call:

| Wrapper | Raw command |
|---|---|
| `pnpm run server:docker:start` | `docker compose --env-file .env -f packages/kb-server/docker-compose.yml up -d --build kb-server` |
| `pnpm run server:docker:logs` | `docker compose --env-file .env -f packages/kb-server/docker-compose.yml logs -f kb-server` |
| `pnpm run server:docker:stop` | `docker compose --env-file .env -f packages/kb-server/docker-compose.yml stop kb-server` |
| reset (wipe index) | `docker compose --env-file .env -f packages/kb-server/docker-compose.yml down -v` |

Drop `--build` once the image exists to boot the already-built image as-is. (The test-only
`llm-mock` stays off unless you add `--profile mock`.)

### Raw `docker run` (prebuilt image, no compose)

If all you have is the image, you don't need the compose file at all — just map the port,
mount a named volume at `/data`, and pass the env. With an `.env` file:

```bash
docker run -d --name kb-server \
  --env-file .env \
  -p 38117:38117 \
  -v kb-data:/data \
  kb-server                       # or REGISTRY/kb-server:TAG
```

Or pass the env explicitly (no file):

```bash
docker run -d --name kb-server \
  -p 38117:38117 \
  -v kb-data:/data \
  -e KB_SERVER_API_KEY=<strong-token> \
  -e GEMINI_API_KEY=<provider-key> \
  -e KB_BASE=acme \
  -e KB_GIT_REPOS=https://github.com/acme/auth,https://github.com/acme/web \
  -e KB_REINDEX_INTERVAL=1h \
  kb-server
```

The image already sets `KB_HOME=/data`, `PORT=38117`, and a CMD of
`kb-server start --with-mcp`, so the volume mount is what makes the index survive
restarts. Lifecycle is plain Docker:

```bash
docker logs -f kb-server     # watch first-boot clone + index
docker stop kb-server        # keeps the volume + index
docker start kb-server       # reuse the persisted index
docker rm -f kb-server && docker volume rm kb-data   # full reset
```

### Build the image standalone

`server:up` / compose build for you; to build by hand (context is the **repo root**):

```bash
docker build -f packages/kb-server/Dockerfile -t kb-server .
```

## Verify

```bash
# Liveness (no auth). `ok:true` + an indexMtime means the index is built and serving.
curl http://localhost:38117/healthz

# A real query (use your KB_SERVER_API_KEY).
curl -s http://localhost:38117/v1/query \
  -H "Authorization: Bearer $KB_SERVER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"how does auth work?"}'
```

The image starts with `--with-mcp`, so MCP clients can connect at `POST /mcp` with the
same bearer token — see [`src/SERVER.md`](src/SERVER.md) for the
Claude Code / Cursor wiring and the full endpoint + tool list.

**Slack:** Slack handling now runs inside `kb-server` itself. Enable it with
`KB_SERVER_ENABLE_SLACK=true` plus real `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`
to serve `POST /slack/events` on the same host.

## Operate

```bash
pnpm run server:docker:logs   # tail the container logs (index build, reindex, requests)
pnpm run server:docker:stop   # stop the container (keeps the /data volume + index)
pnpm run server:up            # start again — reuses the persisted index

# Force a fresh index (wipes the volume):
docker compose --env-file .env -f packages/kb-server/docker-compose.yml down -v
```

On-demand reindex without a restart: `POST /v1/reindex` with the bearer token.
This uses the same incremental sync path as the hourly scheduler: every tracked repo is
polled, but only repos with new commits are re-indexed.

## Notes

- **Single writer.** One instance owns the SQLite index; don't run multiple replicas
  against the same volume unless you redesign the storage model around shared writes.
- **First boot is slow.** Cloning + indexing can take a while; the server now starts
  listening first, `/healthz` reports `indexing: true`, and query/chat/MCP calls return
  a temporary `503` until the initial build finishes. The compose healthcheck allows a
  5-minute `start_period`.
- **The `mock` profile is test-only.** The WireMock `llm-mock` sidecar is gated behind the
  `mock` compose profile and never starts for real runs; `pnpm run integration:test` opts
  it in. Details: [`docker/wiremock/WIREMOCK.md`](docker/wiremock/WIREMOCK.md).

## Related docs

- [`src/SERVER.md`](src/SERVER.md) — server internals, endpoints, MCP clients
- [`HANDOFF.md`](HANDOFF.md) — build-to-serve handoff: prepared-state export/import
- [`http/HTTP.md`](http/HTTP.md) — API contract + sample requests
- [`INTEGRATION_TEST.md`](INTEGRATION_TEST.md) — the Docker-based test harness
