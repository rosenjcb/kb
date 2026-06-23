---
"kb": minor
"kb-server": minor
---

Add structured JSON request tracing to the kb server.

Every HTTP request gets a UUID `requestId` attached as the `x-request-id` response header and embedded in every log line for that request. Log entries are newline-delimited JSON objects on stdout, parseable by Docker, Cloud Logging, Datadog, and any other log aggregator without a sidecar.

What gets traced:
- **Request arrival**: method, path, client IP (proxy-aware via `x-forwarded-for`), user-agent
- **Response completion**: status code, latency (`durationMs`) — emitted at `info`/`warn`/`error` level by status range
- **Auth failures**: whether a key was present (not the key value), path, method
- **`/v1/query`**: query text (truncated to 300 chars), params, and on completion: results count, answer presence, retrieval method, duration
- **`/v1/chat`**: session ID, message text (truncated), and on completion: answer length, facts retrieved, duration; per-SSE-event detail at `debug` level
- **`/v1/reindex`**: start, per-progress lines (`debug`), summary and duration on completion
- **`/mcp`**: JSON-RPC method name
- **Server startup**: port, base, LLM provider/model, MCP enabled, API key count, reindex interval
- **Server shutdown**: signal received

Control verbosity via `LOG_LEVEL` env var (`debug` | `info` | `warn` | `error`; default: `info`). Added to `.env.example` and `docker-compose.yml`.
