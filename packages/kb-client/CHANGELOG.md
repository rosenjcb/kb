# @kb/client

## 1.3.22

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.13

## 1.3.21

### Patch Changes

- Organizational Ontology Index, indexing only (issue #167): entity registry tables (entities, aliases, edges, fact links), deterministic ecosystem harvesters (TS workspaces, compose, fly.toml, Backstage catalog) wired into init/scan as an `entity-index` cycle with a `KB_ENTITY_INDEX=false` kill switch, deterministic name-collision detection, and a `kb entities` CLI (list, show, collisions). Retrieval is unchanged — nothing in the query path reads these tables yet.
- Updated dependencies
  - @kb/core@1.5.12

## 1.3.20

### Patch Changes

- Bump forward after merging main: main independently published `@kb/client@1.3.19` and `@kb/server@1.5.1` with different content than this branch's own patch bumps to the same version numbers, so both need one more patch step to avoid a version collision.

## 1.3.19

### Patch Changes

- Consolidate connection resolution: remove `KB_SERVER_URL` in favor of decomposed `KB_HOST`/`KB_PORT`/`KB_SSLMODE` (or `KB_CONNECTION_STRING`), so a bare hostname resolves the same scheme/port whether it arrives via `--host` or a `kb://` connection string. Add `--port`, `--sslmode`, and `--api-key`/`--key` as global CLI flags. `kb mcp install` no longer hand-rolls its own flag parser. The CLI banner now auto-discovers the server's default base for display when no local base is selected.
- Clarify end-of-session feedback hook docs: outstanding feedback uses singular `requestId`, not a `requestIds` array.
- Updated dependencies
  - @kb/core@1.5.11

## 1.3.18

### Patch Changes

- `kb skills install` now also registers an end-of-session feedback hook for Claude Code (`~/.kb/hooks/kb-feedback.sh`): it records that the session used kb_query via PostToolUse, then reminds the agent once — at the first `git push`, or by blocking the first Stop as a fallback — to call the new `get_feedback_requests` MCP tool and resolve what it returns via `submit_feedback` (one `requestId` per call, no batching), so answer-quality feedback arrives after the work is validated instead of right after the query. Silent once feedback is submitted, after one nudge, when kb_query was never used, or with `KB_FEEDBACK_REMINDER=false`; `kb skills uninstall` removes the hook entries.

## 1.3.17

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.10

## 1.3.16

### Patch Changes

- Remove `kb:dump-context` (superseded by the `spec-md` skill) and `kb:evaluation-run` (now maintained as a user-level skill outside this repo) from the bundled skill set. Fixes a real crash: `skill-installer.ts` called `loadSkill()` for both at module load time, so `kb skills install` (and anything importing it) threw `ENOENT` once the `skills/kb:dump-context/` and `skills/kb:evaluation-run/` source directories were removed from the repo.
- Updated dependencies
  - @kb/core@1.5.9

## 1.3.15

### Patch Changes

- Thin client always talks HTTP to a kb-server host. LLM provider auto-selection is announced at kb-server startup.
- Updated dependencies
  - @kb/core@1.5.8

## 1.3.14

### Patch Changes

- Fix rescan hash lost during init
- Updated dependencies
  - @kb/core@1.5.7

## 1.3.13

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.6

## 1.3.12

### Patch Changes

- Fix CLI "could not connect (404)" against Cloud Run servers: the health probe now prefers `/health` (which passes through Google's frontend) and falls back to `/healthz` for older servers. Google's edge intercepts `/healthz` on `*.run.app` and 404s it before it reaches kb-server, which made a healthy remote server look unreachable.

## 1.3.11

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.5

## 1.3.10

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.4

## 1.3.9

### Patch Changes

- Drop unused HTTP client helper for admin rescan; index refresh is scheduler- and `kb-server scan`-driven.
- Per-repo Sources blob links from the volume registry (slug → gitUrl + primary clone branch); remove global KB*SOURCE*\* env; expose QuerySource.gitRepo on the wire.
- GitHub Pages chat demo + CORS; shared chat Sources footer and Slack mrkdwn conversion; keep remote chat thinking when stage meta arrives.
- Updated dependencies
  - @kb/core@1.5.3

## 1.3.8

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.2

## 1.3.7

### Patch Changes

- Facelift `kb:dev-workflow` skill: ask semantically meaningful natural-language
  questions via MCP `kb_query` only (not keyword salad); verify against returned
  source facts / `filePath`s. No CLI/TUI mentions — agents must not think that
  surface exists for investigation.

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

## 1.3.6

### Patch Changes

- `kb mcp install` now accepts `--key`/`--api-key` to write the Bearer header without exporting `KB_SERVER_API_KEY` first (the flag wins over env/config when both are set). Fixes the remote-install flow that previously required setting the env var upfront.

## 1.3.5

### Patch Changes

- Updated dependencies
  - @kb/core@1.5.0

## 1.3.4

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.7

## 1.3.3

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.6

## 1.3.2

### Patch Changes

- Compact FR/TC ids for spec-md contiguous ordering and remap matching [TC-N] tags.
- Updated dependencies
  - @kb/core@1.4.5

## 1.3.1

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
  - `kb skills install` / `kb mcp install` write MCP configs for the active
    CLI/TUI connection (localhost default) instead of requiring an explicit
    `--host` / env and printing `needs-host`.

- Updated dependencies
  - @kb/core@1.4.4

## 1.3.0

### Minor Changes

- Keep `@kb/core` version internal: CLI/TUI and `kb-server` surfaces show client/server semver only; drop `version.core` from `/healthz` and MCP metadata.

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.3

## 1.2.10

### Patch Changes

- Agents investigate via the kb MCP connection only (CLI/TUI is for humans). Add `kb mcp install|status|uninstall` so Cursor/Claude `mcpServers.kb` points at an **explicit** local or remote host (`--host`, `KB_SERVER_URL`, `KB_HOST`, or `config.server.host`) — never an invented localhost default. Pass loaded `KbConfig` into MCP sync (Bearer from `config.server.apiKey`), exit non-zero on `needs-host` / install failures, and clear stale Authorization when no API key is set. Fix Claude Code hooks: emit PreToolUse JSON `additionalContext` (plain stdout was ignored), match `Bash|Grep|Glob`, and always create `~/.claude` on install. Document team remote setup in the README (shared server → human CLI + agent MCP).
- Keep `kb mcp` client-local so remote mode does not forward it to `/v1/admin/cli`. Stop auto-installing agent skills and rewriting MCP configs on CLI/TUI startup (opt-in via `kb skills install` / `kb mcp install` only).
- Type `HealthResponse.version` for `/healthz` (`server` + `core` package versions).
- Renumber colliding skill-installer / remote-command TC IDs (TC-630–633, TC-626) so CONNECTION vs CLI ownership is unique.
- Updated dependencies
  - @kb/core@1.4.2

## 1.2.9

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.1

## 1.2.8

### Patch Changes

- Updated dependencies
  - @kb/core@1.4.0

## 1.2.7

### Patch Changes

- Fix two client bugs: surface a clear, red, actionable message (pointing at
  `KB_SERVER_API_KEY`) when the server rejects a request for want of an API key
  instead of a bare "unauthorized", and stream the server's reasoning/progress
  into the chat spinner so it shows live status rather than a frozen "thinking...".

## 1.2.6

### Patch Changes

- Fix release runtime packaging so install and sync extract self-contained release artifacts instead of relying on npm workspace tarballs.

## 1.2.5

### Patch Changes

- Updated dependencies
  - @kb/core@1.3.1

## 1.2.4

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

- Split GitHub release into `kb-client-node24.tgz` and `kb-server-node24.tgz`; `install-kb.sh` and `kb sync` install both by default. Wire release CI to `@kb/client` / `@kb/server` versions and changelogs.
- Configuration is environment-only: `KB_HOST`/`KB_PORT`, base selection in `~/.kb/state/`. README and DEVELOPERS_GUIDE describe server-managed indexing.
- Server-managed indexing on kb-server (`KB_GIT_REPOS`); client adds global `kb --host` and shows connected host/base in the TUI status bar and CLI banner.

### Patch Changes

- Split uninstall: `kb uninstall` removes client only; `kb-server uninstall --purge` removes server and `~/.kb` data.
- Fix TUI esbuild assert crash, server run telemetry (tokens, host/target column, plain command names), and connection-error hints.
- Enforce strict single-step semver version bumps in CI and git hooks (pre-commit staged guard, pre-push merge gate).
- `pnpm run install:global` installs deps, builds, and symlinks `kb` + `kb-server` for local dev and eval.
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

- Fix client/server split gaps: forward `--type`/`--verbose` on remote `kb query`, let the TUI chat run against a remote server without a local base or LLM key, stop nagging about a missing local API key in remote mode, and correct the server-side `kb graph --base` argument handling so it targets the requested base.
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

## 0.22.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.

### Patch Changes

- Updated dependencies
  - @kb/core@0.22.0
  - @kb/server@0.14.0
