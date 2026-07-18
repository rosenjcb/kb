# kb-server

## 1.4.9

### Patch Changes

- Index refresh is scheduler- and `kb-server scan`-driven.
- Per-repo Sources blob links from the volume registry (slug → gitUrl + primary clone branch); remove global KB*SOURCE*\* env; expose QuerySource.gitRepo on the wire.
- GitHub Pages chat demo + CORS; shared chat Sources footer and Slack mrkdwn conversion; keep remote chat thinking when stage meta arrives.
- Demo treats health timeouts / dropped chat as “busy indexing” and waits; pairs with core wall-clock yields so `/healthz` can answer during first-boot.
- Demo connection Test fails fast on unknown base (404) and bad/missing API key (401 via `/v1/bases`), instead of hanging on “Testing…”.
- Demo Test button paints “Testing…” before the probe and uses a 3s/2s timeout budget so the click feels instant.
- Updated dependencies
  - @kb/core@1.5.3

## 1.4.8

### Patch Changes

- `kb-server start` no longer requires naming a base. When no `--base`,
  `KB_SERVER_BASE_NAME`/`KB_BASE`, or locally-selected base is present, the server
  binds the golden default slug `base` (Postgres's `postgres`-style maintenance DB)
  instead of failing with "No knowledge base selected". Clients that omit a base
  still land on the boot/default base.
- Updated dependencies
  - @kb/core@1.5.2

## 1.4.7

### Patch Changes

- Add one-shot `kb-server scan --base [--from] [--out]` batch reindex for scheduled jobs (adopt → scan → export, then exit; local paths only). Batch defaults always replace an adopt index and overwrite `--out` (no `--force`); `--json` emits success/failure objects; scan targets the resolved base dir.

## 1.4.6

### Patch Changes

- Multi-base support in kb-server plus first-class base/connection-string selection
  on the client.

  - Server: one process can now serve many bases (psql/libpq postmaster model). A
    new base-keyed `KbService` registry resolves the base per request from the
    `X-KB-Base` header (or `?base=` on `/healthz`, or a body `base` on
    `/v1/query` / `/v1/chat`). The default base keeps its bootstrap lifecycle;
    other built bases are created lazily and serve-only. Unknown base ⇒ 404
    `unknown_base`. `GET /v1/bases` now lists the real set of served bases.
  - Client: new `--base` and `--connection-string` global flags (+
    `KB_CONNECTION_STRING`). Connection strings use a libpq-style
    `kb://[apikey@]host[:port]/[base][?sslmode=]` grammar. The resolved connection
    carries the base and `kb-api-client` sends it as `X-KB-Base` on every request.

- Updated dependencies
  - @kb/core@1.5.1

## 1.4.5

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.0

## 1.4.4

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.7

## 1.4.3

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.6

## 1.4.2

### Patch Changes

- Compact FR/TC ids for spec-md contiguous ordering and remap matching [TC-N] tags.
- Updated dependencies
  - @kb/core@1.4.5

## 1.4.1

### Patch Changes

- Fix the kb MCP server to work end-to-end, as it should have since 1.0.0.

  - MCP `kb_query` is now a single, answer-first agent-to-agent tool: it always
    synthesizes a direct answer (no `synthesize` flag) and surfaces the physical
    source files behind each fact instead of opaque `fact://` URIs.
  - kb-server gains a real daemon lifecycle — `start -d` / `stop` / `status` /
    `restart` (pid file under `~/.kb/run`, with a pid-reuse guard on stop) — plus
    `kb-server init` and `kb-server service install|uninstall|status` for
    launchd/systemd. `server:start` now backgrounds the server.
  - Add Google Antigravity / Antigravity CLI support for MCP config sync, global
    skill installation, and BeforeTool hooks.

- Updated dependencies
  - @kb/core@1.4.4

## 1.4.0

### Minor Changes

- Keep `@kb/core` version internal: CLI/TUI and `kb-server` surfaces show client/server semver only; drop `version.core` from `/healthz` and MCP metadata.

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.3

## 1.3.4

### Patch Changes

- Document agents=MCP-only / humans=CLI-TUI split and explicit-host MCP install (`kb mcp install --host`).
- Fix `kb-server --version` so it prints the package version and exits instead of starting the daemon (broke `install:global` smoke when port 38117 was already in use).
- Include `version.server` and `version.core` on `GET /healthz` (and `/health`); bake `@kb/core` semver into the server binary via esbuild `define`.
- Updated dependencies
  - @kb/core@1.4.2 (Gemini default → `gemini-3-flash-preview`)

## 1.3.3

### Patch Changes

- Fix silent "no answer" from a retired model. Google removed `gemini-2.5-flash`, so every generation 404'd and synthesis returned null while retrieval still worked — producing empty answers with no error. Default the Gemini provider to `gemini-3.5-flash`, and surface chat errors in the Slack handler (post the failure into the thread and log it) instead of collapsing them into the generic "produced no answer" warning.
- Updated dependencies
  - @kb/core@1.4.1

## 1.3.2

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.0

## 1.3.1

### Patch Changes

- Rename the build-to-serve prepared-state vocabulary to "snapshot" and add
  `kb-server start --from <dir>` (env `KB_SERVER_SNAPSHOT`) to adopt a local
  snapshot already on disk before serving — no separate `import` step and no
  network download. The bootstrap policy `prepared-only` becomes `snapshot-only`,
  the manifest is `kb-snapshot.json` (`kind: "kb-snapshot"`), and `export`/`import`
  share one restore path with the new startup flag. A serving worker can now boot
  straight from prepared state on a mounted volume with
  `kb-server start --from /mnt/kb-state --bootstrap-policy snapshot-only`.
- Updated dependencies
  - @kb/core@1.3.1

## 1.3.0

### Minor Changes

- f22e369: Add a generic build-to-serve handoff model. `@kb/core` gains a versioned
  prepared-state artifact contract (`kb-prepared.json`) with provenance,
  integrity digest, and a forward-only index-schema compatibility check.
  `kb-server` gains `export`/`import` subcommands to snapshot a built base into a
  portable bundle and restore it elsewhere, plus a `--bootstrap-policy`
  (`KB_SERVER_BOOTSTRAP_POLICY`) `prepared-only` mode so a lightweight worker
  serves pre-built state without ever running the heavy build.

### Patch Changes

- Updated dependencies [f22e369]
  - @kb/core@1.3.0

## 1.2.3

### Patch Changes

- Purge the `meta.json` / `.kbignore` / `kb-server.json` config layer — the server is now configured entirely through environment variables (these are Docker service nodes, not local checkouts). Repos and their branches come from `KB_SERVER_BASE_GIT_REPOS` (inline `url#branch`), index-ignore patterns from the new `KB_SERVER_IGNORE`, and a base's tracked repos are discovered from the git clones on its volume rather than a persisted sidecar file. Drops the `kb base repo` and `kb base ignore` commands and the `kb-server.json` bootstrap manifest.
- Updated dependencies
  - @kb/core@1.2.3

## 1.2.2

### Patch Changes

- Remove unintentional flags that were never meant to ship: `--type` and `--limit` on `kb query` (CLI parsing and help, remote client forwarding, HTTP query request fields, OpenAPI schema, and the `kb_query` MCP tool input), and `--type` on `docs generate` (the doc type is now always classified from the prompt). Fact retrieval uses the server-side defaults. The separate `docs list`/`docs generate`/`facts`/`logs` `--limit` options and `graph node --type` are unchanged.
- Updated dependencies
  - @kb/core@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c204d60]
  - @kb/core@1.2.1

## 1.2.0

### Minor Changes

- Split uninstall: `kb-server uninstall --purge` removes server binary and `~/.kb` data; client uninstall is client-only.

### Patch Changes

- Fix run telemetry on `/v1/query` and `/v1/chat` (real LLM token counts, plain command names).
- Align with env-only client configuration and release CI version wiring.
- Updated dependencies
  - @kb/core@1.2.0

## 1.1.4

### Patch Changes

- Standardize the default kb-server listen port to 38117 (CLI, Docker, client fallback, eval harness).
- Updated dependencies
  - @kb/core@1.1.4

## 1.1.3

### Patch Changes

- Add `KB_QUERY_TIMEOUT`, fix `/healthz` readiness during bootstrap, and restore remote `kb query --trace`.
- Updated dependencies
  - @kb/core@1.1.3

## 1.1.2

### Patch Changes

- Updated dependencies
  - @kb/core@1.1.2

## 1.1.1

### Patch Changes

- Standardize boolean env vars to `true`/`false` only; bundle JS deps in CLI/server builds so global install resolves runtime modules.
- Updated dependencies
  - @kb/core@1.1.1

## 1.1.0

### Minor Changes

- Route all kb commands through kb-server REST: POST /v1/admin/cli for init/scan/docs/facts/graph/logs/publish/base; client remote dispatch by default.

### Patch Changes

- Updated dependencies
  - @kb/core@1.1.0

## 1.0.0

### Major Changes

- 1.0.0 client-server split: `kb` CLI/TUI client, `kb-server` daemon, `@kb/core` shared domain. Remote query/chat over REST+SSE; `kb server` subcommand removed.

### Patch Changes

- Updated dependencies
  - @kb/core@1.0.0

## 0.14.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.

### Patch Changes

- Updated dependencies
  - @kb/client@0.22.0
  - @kb/core@0.22.0

## 0.13.2

### Patch Changes

- Adopt spec.md behavioral specs (FR/TC tables), test `[TC-N]` tags, and a CI traceability gate.

## 0.13.1

### Patch Changes

- Fix kb-server's scheduled reindex behavior, restore Docker Slack env wiring, and simplify the changeset workflow so `changeset:version` is the single apply path.

## 0.13.0

### Minor Changes

- 2c46eb5: Add structured JSON request tracing to the kb server.

  Every HTTP request gets a UUID `requestId` attached as the `x-request-id` response header and embedded in every log line for that request. Log entries are newline-delimited JSON objects on stdout, parseable by Docker, Cloud Logging, Datadog, and any other log aggregator without a sidecar.

  What gets traced:

  - **Request arrival**: method, path, client IP (proxy-aware via `x-forwarded-for`), user-agent
  - **Response completion**: status code, latency (`durationMs`) — emitted at `info`/`warn`/`error` level by status range
  - **Auth failures**: whether a key was present (not the key value), path, method
  - **`/v1/query`**: query text (truncated to 300 chars), params, and on completion: results count, answer presence, retrieval method, duration
  - **`/v1/chat`**: session ID, message text (truncated), and on completion: answer length, facts retrieved, duration; per-SSE-event detail at `debug` level
  - **Scheduled index refresh**: start, per-progress lines (`debug`), summary and duration on completion
  - **`/mcp`**: JSON-RPC method name
  - **Server startup**: port, base, LLM provider/model, MCP enabled, API key count, reindex interval
  - **Server shutdown**: signal received

  Control verbosity via `LOG_LEVEL` env var (`debug` | `info` | `warn` | `error`; default: `info`). Added to `.env.example` and `docker-compose.yml`.

## 0.12.0

### Minor Changes

- Add a getting-started path for self-hosting the kb server from the Docker image: a guided `pnpm run server:up` bootstrap (seeds `.env`, validates config, builds + boots), `server:logs`, a `packages/kb-server/README.md` deploy guide, and a test-only `mock` compose profile so real runs no longer start the WireMock sidecar.

## 0.11.0

### Minor Changes

- df35234: Add `kb server start`: HTTP API (`/v1/query`, `/v1/chat` SSE, `/healthz`) with optional MCP at `POST /mcp` via `--with-mcp`. `kb-server` package: Docker image, WireMock integration suite (`packages/kb-server/http/server.http`), and compose wiring.
