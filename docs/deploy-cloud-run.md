# Deploying the kb server to Cloud Run

`kb server start` runs the knowledge base as a long-lived HTTP + MCP service so
indexing happens once, centrally, instead of on every developer's machine.

## Architecture (v1)

Single Cloud Run service backed by a **persistent volume**:

- The volume is mounted at `/data` and `KB_HOME=/data`, so the entire `~/.kb`
  tree (the `.kb-index.sqlite` index, base metadata, cloned repos, and
  `kb docs generate` output) lives on durable storage.
- **First boot** builds the index from `KB_GIT_REPOS` (or rescans a base that
  already tracks repos). **Later boots reuse** the persisted index — no reindex.
- An in-process scheduler reindexes on a cadence (`KB_REINDEX_INTERVAL`,
  default hourly) via incremental `git pull` + hash-diffed re-index. Reads keep
  serving the current index during a rescan (SQLite WAL).
- Run with `--min-instances=1` (stay warm) and `--max-instances=1` (single
  writer → no cross-instance SQLite write contention). Prefer **Filestore (NFS)**
  for the volume; GCS FUSE has unreliable locking for SQLite writes.

## Endpoints

| Method/Path      | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `POST /v1/query` | Synthesized answer + sources (Slack & apps)        |
| `POST /v1/chat`  | Multi-turn chat, streamed over SSE                 |
| `GET  /healthz`  | Liveness/readiness (unauthenticated)               |
| `POST /v1/reindex` | On-demand incremental rescan                     |
| `POST /mcp`      | MCP Streamable HTTP (LLM clients), when `--mcp`     |

`/v1/*` and `/mcp` require `Authorization: Bearer <KB_SERVER_API_KEY>`.

## Environment

| Var                  | Purpose                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `PORT`               | HTTP port (Cloud Run sets this; default 8080)                     |
| `KB_HOME`            | Data dir — point at the mounted volume (`/data`)                  |
| `KB_BASE`            | Base name to serve                                                 |
| `KB_GIT_REPOS`       | Comma-separated git URLs to boot-build a fresh base               |
| `KB_SERVER_API_KEY`  | Bearer key(s) for `/v1` and `/mcp` (comma-separated for rotation) |
| `KB_REINDEX_INTERVAL`| Reindex cadence, e.g. `1h`, `30m`, `10s`, or `0` to disable       |
| `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) | LLM provider for synthesis |

Back secrets with Secret Manager.

## Build & deploy

```bash
# Build and push the image.
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/kb/kb-server

# Deploy (Filestore volume mounted at /data).
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

> The example uses a Cloud Storage volume for brevity; for write-heavy bases
> (frequent `kb docs generate`) prefer a Filestore (NFS) volume for reliable
> SQLite locking.

Point the Cloud Run startup/liveness probe at `GET /healthz` — it returns `503`
until the index is loaded, then `200`.
