# kb server — HTTP examples and integration tests

OKF companion: [`HTTP.md`](HTTP.md) (contract, httpyac config, CI wiring).

| File | Purpose |
|---|---|
| [`server.http`](server.http) | httpyac collection — examples + integration suite (10 requests) |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.0 for REST + MCP |
| [`.httpyac.js`](.httpyac.js) | Environments (`local`, `docker`, `prod`) |
| [`http-client.env.json`](http-client.env.json) | VS Code / Cursor httpyac env fallback |
| [`package.json`](package.json) | `"type": "commonjs"` for httpyac in this ESM repo |

## Quick commands

```bash
# one request (server already running)
pnpm exec httpyac send http/server.http -n query --env local

# full file
pnpm exec httpyac send http/server.http --all --env local

# integration suite (Docker up → httpyac → down)
pnpm run integration:test
```

## Local server

```bash
cp .env.example .env   # real provider key for manual runs (not integration:test)
pnpm run server:start  # docker compose up
pnpm run server:stop
```

## MCP (stdio)

```bash
pnpm run mcp:start
pnpm run mcp:stop
```

Unit tests: `pnpm run unit:test`. Server implementation: [`../src/server/SERVER.md`](../src/server/SERVER.md).
