---
type: Guide
title: Deploy KB Server to Cloud Run
description: Single-service Cloud Run layout with persistent volume, boot-build, and scheduled reindex.
resource: ./Dockerfile
tags: [cloud-run, deploy, server, docker]
timestamp: 2026-06-22T00:00:00Z
---

# Deploy KB Server to Cloud Run

`kb server start` packages as a container for **one long-lived instance** with durable storage at `/data` (`KB_HOME`). Indexing runs centrally; clients call HTTP/MCP instead of local `kb init` per machine.

## Architecture (v1)

- Volume at `/data` holds the full `~/.kb` tree (SQLite index, `meta.json`, repo clones).
- **First boot** builds from `KB_GIT_REPOS` or rescans repos in `meta.json`. **Later boots reuse** the index — no full reindex on restart.
- In-process scheduler reindexes on `KB_REINDEX_INTERVAL` (default `1h`) via incremental `git pull` + hash-diff scan. SQLite WAL serves reads during rescan.
- Run `--min-instances=1 --max-instances=1` (single writer). Prefer **Filestore (NFS)** over GCS FUSE for SQLite locking.

## Endpoints

| Method / path | Purpose |
|---|---|
| `POST /v1/query` | Synthesized answer + sources |
| `POST /v1/chat` | Multi-turn chat (SSE) |
| `GET /healthz` | Liveness (unauthenticated) |
| `POST /v1/reindex` | On-demand incremental rescan |
| `POST /mcp` | MCP Streamable HTTP when started with `--with-mcp` |

`/v1/*` and `/mcp` require `Authorization: Bearer <KB_SERVER_API_KEY>`.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (Cloud Run sets; default 8080) |
| `KB_HOME` | Data dir on mounted volume (`/data`) |
| `KB_BASE` | Base name to serve |
| `KB_GIT_REPOS` | Comma-separated URLs for fresh-volume boot-build |
| `KB_SERVER_API_KEY` | Bearer key(s); comma-separated for rotation |
| `KB_REINDEX_INTERVAL` | e.g. `1h`, `30m`, `0` to disable |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM for synthesis |

Back secrets with Secret Manager. Point startup/liveness probes at `GET /healthz`.

## Build and deploy

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/kb/kb-server

gcloud run deploy kb-server \
  --image REGION-docker.pkg.dev/PROJECT/kb/kb-server \
  --region REGION \
  --min-instances 1 --max-instances 1 \
  --cpu 1 --memory 1Gi --concurrency 8 \
  --add-volume name=kb-data,type=cloud-storage,bucket=YOUR_BUCKET \
  --add-volume-mount volume=kb-data,mount-path=/data \
  --set-env-vars KB_HOME=/data,KB_BASE=acme,KB_REINDEX_INTERVAL=1h \
  --set-secrets KB_SERVER_API_KEY=kb-api-key:latest,GEMINI_API_KEY=gemini-key:latest \
  --set-env-vars KB_GIT_REPOS=https://github.com/acme/auth,https://github.com/acme/web
```

Example uses Cloud Storage for brevity; production write-heavy bases should use Filestore (NFS).

## Invariants

- Single writer instance — do not scale Cloud Run past one replica without externalizing the index.
- `KB_HOME` must be on durable storage; ephemeral container FS loses the index on restart.
- Boot-build can exceed default probe timeouts — configure adequate `start_period` (see `packages/kb-server/docker-compose.yml` healthcheck).

## Related docs

- [`../src/server/SERVER.md`](../src/server/SERVER.md) — runtime behavior
- [`../http/HTTP.md`](../http/HTTP.md) — API contract and smoke tests
- [`../packages/kb-server/docker-compose.yml`](../packages/kb-server/docker-compose.yml) — local mirror of the deploy model
