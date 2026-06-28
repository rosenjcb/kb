# kb server — HTTP examples and integration tests

OKF companion: [`HTTP.md`](HTTP.md). Behavioral spec: [`HTTP.spec.md`](HTTP.spec.md).

| File | Purpose |
|---|---|
| [`server.http`](server.http) | httpyac collection — examples + integration suite (10 requests) |
| [`slack.http`](slack.http) | Slack webhook surface — unsigned rejection, challenge, app_mention, DM |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.0 for REST + MCP |
| [`.httpyac.js`](.httpyac.js) | Environments (`local`, `docker`, `prod`) — includes `slackSigningSecret` |
| [`http-client.env.json`](http-client.env.json) | VS Code / Cursor httpyac env fallback |
| [`package.json`](package.json) | `"type": "commonjs"` for httpyac in this ESM repo |

## Quick commands

```bash
pnpm exec httpyac send packages/kb-server/http/server.http -n query --env local
pnpm exec httpyac send packages/kb-server/http/server.http --all --env local
pnpm exec httpyac send packages/kb-server/http/slack.http --all --env local
pnpm run integration:test
```

## Local server (manual httpyac)

```bash
export KB_SERVER_API_KEY=testkey   # match http/.httpyac.js apiKey
pnpm run server:start              # local REST + POST /mcp (required for full suite)
pnpm exec httpyac send packages/kb-server/http/server.http --all --env local
```

Without `--with-mcp`, MCP requests in `server.http` return 404.

## Docker

```bash
cp .env.example .env
pnpm run server:up              # guided Docker bootstrap
# or raw compose:
docker compose --env-file .env -f packages/kb-server/docker-compose.yml up -d --build kb-server
```

To stand up a real, self-hosted KB (guided `.env` + first-boot indexing), use
`pnpm run server:up` — see [`../README.md`](../README.md).

## MCP clients

With `kb server start --with-mcp` running, connect Claude Code or Cursor Agent — see [`../../../src/server/SERVER.md`](../../../src/server/SERVER.md).

Server implementation: [`../../../src/server/SERVER.md`](../../../src/server/SERVER.md).
