# kb server — HTTP examples and integration tests

OKF companion: [`HTTP.md`](HTTP.md).

| File | Purpose |
|---|---|
| [`server.http`](server.http) | httpyac collection — examples + integration suite (10 requests) |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.0 for REST + MCP |
| [`.httpyac.js`](.httpyac.js) | Environments (`local`, `docker`, `prod`) |
| [`http-client.env.json`](http-client.env.json) | VS Code / Cursor httpyac env fallback |
| [`package.json`](package.json) | `"type": "commonjs"` for httpyac in this ESM repo |

## Quick commands

```bash
pnpm exec httpyac send http/server.http -n query --env local
pnpm exec httpyac send http/server.http --all --env local
pnpm run integration:test
```

## Local server (manual httpyac)

```bash
export KB_SERVER_API_KEY=testkey   # match http/.httpyac.js apiKey
kb server start --with-mcp         # REST + POST /mcp (required for full suite)
pnpm exec httpyac send http/server.http --all --env local
```

Without `--with-mcp`, MCP requests in `server.http` return 404.

## Docker

```bash
cp .env.example .env
pnpm run server:start   # docker compose; image CMD includes --with-mcp
pnpm run server:stop
```

Server implementation: [`../src/server/SERVER.md`](../src/server/SERVER.md).
