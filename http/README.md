# kb server — HTTP collection, OpenAPI, and integration tests

- **`kb-api.http`** — [httpyac](https://httpyac.github.io/) request collection for
  every endpoint (`/healthz`, `/v1/query`, `/v1/chat`, `/v1/reindex`, `/mcp`).
  Each request carries `test()`/`assert` blocks that check response **structure**
  (status, shape), not specific content — so they double as the integration suite.
- **`openapi.yaml`** — OpenAPI 3.0 definition of the REST surface (and the MCP
  JSON-RPC endpoint). Load it in Swagger UI / Redoc, or generate clients.
- **`http/.httpyac.js`** — environments co-located with the collection (`local`, `docker`, `prod`).
  Uses CommonJS (`module.exports`) via **`http/package.json`** (`"type": "commonjs"`) because the
  root repo is ESM (`"type": "module"` in `package.json`).
- **`http/http-client.env.json`** — same variables in JetBrains/httpyac env format (fallback for
  the VS Code / Cursor httpyac extension).
- Root **`.httpyac.json`** — same values for `pnpm exec httpyac` runs from the repo root.

## Use as examples

VS Code: install the **httpyac** extension and click "send" above any request.

CLI (httpyac is a devDependency; examples use `pnpm exec`):

```bash
# one request
pnpm exec httpyac send http/kb-api.http -n query --env local
# whole file (against a server you already started)
pnpm exec httpyac send http/kb-api.http --all --env local
```

## Use as the integration suite

```bash
pnpm run integration:test
```

This spins up the server in Docker (`docker-compose.yml`), waits for `/healthz`,
runs the httpyac suite against it, then tears the container down. The exit code is
the suite result.

LLM calls are stubbed by the **WireMock** sidecar (`llm-mock` service). Local runs
and CI use the same path: `pnpm run integration:test` always points Gemini at
`http://llm-mock:8080` and ignores any real keys in your shell or `.env`.

For manual `docker compose up` against a real provider, set `GEMINI_API_KEY` (and
leave `GEMINI_API_BASE_URL` unset) in `.env` instead.

Requirements:

- Docker + `docker compose`.
- `KB_GIT_REPOS` controls what is indexed on first boot (defaults to a small
  public repo). First boot clones + indexes before the server reports healthy.

Unit tests are separate: `pnpm run unit:test` (alias `pnpm run test`).

## Run the server locally

```bash
cp .env.example .env   # provider key for manual runs (not integration:test)
pnpm run server:start  # docker compose up
pnpm run server:stop
```

## MCP for IDE clients (stdio)

```bash
pnpm run mcp:start     # foreground — Ctrl+C to stop
# MCP over HTTP (same port as server):
node --env-file=.env.local --import tsx src/cli/index.ts mcp start --http
pnpm run mcp:stop
```
