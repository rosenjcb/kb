---
type: Playbook
title: Integration Test Runner
description: Docker-compose orchestration and httpyac suite for the kb HTTP server.
resource: ./scripts/integration-test.mjs
tags: [integration-test, docker, httpyac, ci]
timestamp: 2026-06-22T00:00:00Z
---

# Integration Test Runner

`pnpm run integration:test` runs `packages/kb-server/scripts/integration-test.mjs` from `packages/kb-server/` compose cwd; httpyac uses `packages/kb-server/http/server.http`.

## Role in the stack

```mermaid
flowchart TD
  A["down -v clean slate"]
  B["compose up -d --build --wait"]
  C["waitForHealth host /healthz"]
  D["pnpm exec httpyac send server.http --all"]
  E["compose down -v"]
  A --> B --> C --> D --> E
```

Distinct from `pnpm run unit:test` (Vitest, no Docker). Complements `tests/server/*.test.ts` (in-process HTTP mocks).

## Environment (forced in script)

| Variable | Default | Notes |
|---|---|---|
| `KB_SERVER_BASE_NAME` | `integration` | Base name inside container |
| `KB_SERVER_BASE_GIT_REPOS` | `sindresorhus/is` | Small public repo for first-boot index |
| `KB_SERVER_API_KEY` | `testkey` | Must match httpyac `apiKey` |
| `KB_REINDEX_INTERVAL` | `0` | Disable scheduler noise in tests |
| `GEMINI_API_KEY` | `integration-mock-key` | Dummy |
| `GEMINI_API_BASE_URL` | `http://llm-mock:8080` | WireMock sidecar DNS |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | cleared | Prevent auto-detect bypass |
| `KB_TEST_BASE_URL` | `http://localhost:38117` | Host-side health + httpyac target |

## Health wait

After compose `--wait` (container healthcheck), the script polls host `GET /healthz` until:

1. HTTP 200
2. JSON `ok: true` and `indexMtime` string present
3. **Two consecutive** successes (2s apart)

Timeout: 6 minutes (first boot clone + index). On failure, prints `docker compose logs --tail 80`.

## Integration

- **CI:** `.github/workflows/integration.yml` on push to `main` (+ manual dispatch). Feature-branch `ci.yml` is lint/test/build only.
- **httpyac:** `pnpm exec httpyac` from devDependency (not `dlx`).
- **Requirements:** Docker + `docker compose` only.

## Invariants

- Integration must use WireMock — no opt-out to real providers from shell env.
- Suite file: `packages/kb-server/http/server.http` (from repo root).
- Always `down -v` before and after to avoid stale volumes racing health checks.
- Do not shorten health wait below index boot time on cold CI runners.

## Related docs

- [`http/HTTP.md`](http/HTTP.md) — collection and assert conventions
- [`docker/wiremock/WIREMOCK.md`](docker/wiremock/WIREMOCK.md) — LLM stubs
- [`src/SERVER.md`](src/SERVER.md) — what is under test
