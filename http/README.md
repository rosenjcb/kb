# kb server — HTTP collection, OpenAPI, and integration tests

- **`kb-api.http`** — [httpyac](https://httpyac.github.io/) request collection for
  every endpoint (`/healthz`, `/v1/query`, `/v1/chat`, `/v1/reindex`, `/mcp`).
  Each request carries `test()`/`assert` blocks that check response **structure**
  (status, shape), not specific content — so they double as the integration suite.
- **`openapi.yaml`** — OpenAPI 3.0 definition of the REST surface (and the MCP
  JSON-RPC endpoint). Load it in Swagger UI / Redoc, or generate clients.
- **`.httpyac.json`** (repo root) — environments (`local`, `docker`, `prod`) and
  variables (`{{baseUrl}}`, `{{apiKey}}`). `apiKey` must equal the server's
  `KB_SERVER_API_KEY`.

## Use as examples

VS Code: install the **httpyac** extension and click "send" above any request.

CLI (httpyac is fetched on demand, not a repo dependency):

```bash
# one request
pnpm dlx httpyac send http/kb-api.http -n query --env local
# whole file
pnpm dlx httpyac send http/kb-api.http --all --env local
```

## Use as the integration suite

```bash
pnpm run integration:test
```

This spins up the server in Docker (`docker-compose.yml`), waits for `/healthz`,
runs the httpyac suite against it, then tears the container down. The exit code is
the suite result.

Requirements:

- Docker + `docker compose`.
- An LLM provider key in your environment so `/v1/query` and `/v1/chat` can
  synthesize: `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
- `KB_GIT_REPOS` controls what is indexed on first boot (defaults to a small
  public repo). First boot clones + indexes before the server reports healthy.

Unit tests are separate: `pnpm run unit:test` (alias `pnpm run test`).
