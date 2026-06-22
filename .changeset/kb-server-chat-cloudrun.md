---
"kb": minor
---

Server phase 2 + 3: streaming chat and Cloud Run packaging.

- `POST /v1/chat`: multi-turn chat streamed over SSE. Reuses the existing chat
  synthesis loop via an injected printer adapter; reasoning, the model's
  `query_kb` calls, the final answer (with sources), and `done` arrive as SSE
  events. Per-session history is kept in memory (`SessionStore`, TTL + turn cap).
- Boot-build-if-missing: `kb server start` / `kb mcp start` build the index on
  first boot from `KB_GIT_REPOS` (fresh volume) or by rescanning a base that
  already tracks repos, then reuse the persisted index on later boots.
- Cloud Run packaging: multi-stage `Dockerfile`, `.dockerignore`,
  `docker-compose.yml`, and `docs/deploy-cloud-run.md` (single container +
  persistent volume at `KB_HOME=/data`, single-writer model, env/secret wiring).
