# @kb/core

## 1.6.0

### Minor Changes

- Organizational Ontology Index (issue #167): entity registry + harvest cycle across ecosystems (TS/Go/Python/Rust/PHP/Ruby/Java/Haskell/C++/C#/Scala packages, infra, OpenAPI/protobuf, tier-4 routes and app-layer `module`/`model` capture). Exhaustive Prisma schema harvest (`model`/`enum`/`view`/composite `type` + block-level `@@map` aliases; skip generator/datasource/field `@map`/client call-sites) and TypeORM `@Entity({ name|tableName })`. Capture-first denser ontology for later query use — inspect with `kb entities`.
- Tier-4 harvest is YAML-driven: `source_patterns` in `ecosystems/*.yaml` + `common.yaml` select named strategies in `pattern-engine.ts` (`regex`, class/method joins, Rails/Django/OpenAPI/Prisma/Next/tRPC/Symfony/SQL DDL, …). Contributors add simple regex rules in YAML without new TypeScript; unknown strategy ids fail at config load.

## 1.5.11

### Patch Changes

- Consolidate connection resolution: remove `KB_SERVER_URL` in favor of decomposed `KB_HOST`/`KB_PORT`/`KB_SSLMODE` (or `KB_CONNECTION_STRING`), so a bare hostname resolves the same scheme/port whether it arrives via `--host` or a `kb://` connection string. Add `--port`, `--sslmode`, and `--api-key`/`--key` as global CLI flags. `kb mcp install` no longer hand-rolls its own flag parser. The CLI banner now auto-discovers the server's default base for display when no local base is selected.

## 1.5.10

### Patch Changes

- Confirm and document LocalEmbedder's one-time model-load memory cost (issue #196) in INIT.md's memory-scaling notes, with a new isolated regression bench (`scripts/bench/local-embedder-load-bench.sh`).

## 1.5.9

### Patch Changes

- Fix cold-index OOMs on large repos (#191): `SqliteKbIndexer.embedAllFacts` no longer loads every not-yet-embedded fact into one array before batching — it now keyset-paginates the SELECT (page size configurable via `KB_EMBED_FETCH_PAGE_SIZE`, default 1000), so peak memory stays bounded regardless of total fact count. Also removed a redundant full-repo string join/lowercase in `assessTopicCoverage`.
- Remove `kb:dump-context` (superseded by the `spec-md` skill) and `kb:evaluation-run` (now maintained as a user-level skill outside this repo) from the bundled skill set. Fixes a real crash: `skill-installer.ts` called `loadSkill()` for both at module load time, so `kb skills install` (and anything importing it) threw `ENOENT` once the `skills/kb:dump-context/` and `skills/kb:evaluation-run/` source directories were removed from the repo.

## 1.5.8

### Patch Changes

- Thin client always talks HTTP to a kb-server host. LLM provider auto-selection is announced at kb-server startup.

## 1.5.7

### Patch Changes

- Fix rescan hash lost during init

## 1.5.6

### Patch Changes

- Fix multi-repo warm rescan re-indexing every file from scratch. The AST and source
  file-hash change-detection manifests were single base-level files, whole-overwritten with
  repo-relative keys, so each per-repo rescan clobbered the others and every file was reported
  "changed" (0 unchanged → full re-embed). Manifests are now namespaced per git-repo slug
  (`ast-files-manifest.<slug>.json` / `source-files-manifest.<slug>.json`), still base-level so
  they survive `--no-repos` snapshots. Also guard AST-fact reconciliation on a partial rescan:
  instead of blanket-tombstoning every fact not re-seen (which would purge unchanged files'
  facts once incremental actually kicks in), a partial rescan now tombstones only files removed
  from that repo since its last manifest.

## 1.5.5

### Patch Changes

- Show repo provenance as "org/repo" (matching GitHub) in init/scan progress lines and messages, instead of the internal "org-repo" slug. The slug itself is unchanged — it's still used as the clone directory name and the `git_repo` provenance value — this only affects human-facing text.

## 1.5.4

### Patch Changes

- `/healthz` is liveness (always HTTP 200 when reachable) with readiness in the body (`ok` / `indexing`); tighten document-facts wall-clock yields so the probe can answer mid-index; Pages demo reads body flags and matches Slack indexing copy.

## 1.5.3

### Patch Changes

- Per-repo Sources blob links from the volume registry (slug → gitUrl + primary clone branch); remove global KB*SOURCE*\* env; expose QuerySource.gitRepo on the wire.
- GitHub Pages chat demo + CORS; shared chat Sources footer and Slack mrkdwn conversion; keep remote chat thinking when stage meta arrives.
- Yield the event loop on a wall-clock timer during document-facts / AST index (not just every N items) and throttle non-TTY init progress lines so kb-server `/healthz` stays responsive during first-boot bootstrap.

## 1.5.2

### Patch Changes

- `kb-server start` no longer requires naming a base. When no `--base`,
  `KB_SERVER_BASE_NAME`/`KB_BASE`, or locally-selected base is present, the server
  binds the golden default slug `base` (Postgres's `postgres`-style maintenance DB)
  instead of failing with "No knowledge base selected". Clients that omit a base
  still land on the boot/default base.

## 1.5.1

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

## 1.5.0

### Minor Changes

- Retrieval P0 for kb query: lower relevant-score bar for sufficiency plateau/judge gating; curator rank auto-keep + softer minKeep (#155–#158). Eval harness `--trace` is scripts-only (#165).

## 1.4.7

### Patch Changes

- Record fact-curator judge and facts-sufficiency-judge LLM calls as telemetry stages, so `RunReport.totalInputTokens`/`totalOutputTokens` no longer undercount query-path token usage.

## 1.4.6

### Patch Changes

- Add Haskell AST indexing via tree-sitter-haskell (.hs/.lhs).

## 1.4.5

### Patch Changes

- Compact FR/TC ids for spec-md contiguous ordering and remap matching [TC-N] tags.

## 1.4.4

### Patch Changes

- Fix the kb MCP server to work end-to-end, as it should have since 1.0.0.

  - MCP `kb_query` is now a single, answer-first agent-to-agent tool: it always
    synthesizes a direct answer (no `synthesize` flag) and surfaces the physical
    source files behind each fact instead of opaque `fact://` URIs.
  - Facts-loop query results now set `sourcePath` via `sourceRefToPath` (the
    research orchestrator previously left only `fact://` filePaths); path
    segments with colons (e.g. `skills/kb:dev-workflow/…`) resolve correctly.
  - kb-server gains a real daemon lifecycle — `start -d` / `stop` / `status` /
    `restart` (pid file under `~/.kb/run`, with a pid-reuse guard on stop) — plus
    `kb-server init` and `kb-server service install|uninstall|status` for
    launchd/systemd. `server:start` now backgrounds the server.
  - Add Google Antigravity / Antigravity CLI support for MCP config sync, global
    skill installation, and BeforeTool hooks.

## 1.4.3

### Patch Changes

- Keep `@kb/core` version internal: CLI/TUI and `kb-server` surfaces show client/server semver only; drop `version.core` from `/healthz` and MCP metadata.

## 1.4.2

### Patch Changes

- Document agents=MCP-only / humans=CLI-TUI split and explicit-host MCP install (`kb mcp install --host`).
- Default Gemini model to `gemini-3-flash-preview` (was `gemini-3.5-flash`) for ~3x lower cost. `gemini-3.0-flash` is not a real model id and 404'd every generateContent call.

## 1.4.1

### Patch Changes

- Fix silent "no answer" from a retired model. Google removed `gemini-2.5-flash`, so every generation 404'd and synthesis returned null while retrieval still worked — producing empty answers with no error. Default the Gemini provider to `gemini-3.5-flash`, and surface chat errors in the Slack handler (post the failure into the thread and log it) instead of collapsing them into the generic "produced no answer" warning.

## 1.4.0

### Minor Changes

- Procedural-answer support for query and chat synthesis. How-to / step-by-step
  questions now trigger an ordering-focused synthesis directive that reconstructs a
  numbered sequence from the retrieved facts, cites the backing symbol per step, and
  flags gaps instead of fabricating order. Detection and guidance live in the shared
  `query/procedural-intent` helper, wired into both `enrichReadDocumentsAnswerWithLLM`
  (kb query) and `buildChatTurnContent` (chat). No index/retrieval changes.

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

## 1.3.0

### Minor Changes

- f22e369: Add a generic build-to-serve handoff model. `@kb/core` gains a versioned
  prepared-state artifact contract (`kb-prepared.json`) with provenance,
  integrity digest, and a forward-only index-schema compatibility check.
  `kb-server` gains `export`/`import` subcommands to snapshot a built base into a
  portable bundle and restore it elsewhere, plus a `--bootstrap-policy`
  (`KB_SERVER_BOOTSTRAP_POLICY`) `prepared-only` mode so a lightweight worker
  serves pre-built state without ever running the heavy build.

## 1.2.3

### Patch Changes

- Purge the `meta.json` / `.kbignore` / `kb-server.json` config layer — the server is now configured entirely through environment variables (these are Docker service nodes, not local checkouts). Repos and their branches come from `KB_SERVER_BASE_GIT_REPOS` (inline `url#branch`), index-ignore patterns from the new `KB_SERVER_IGNORE`, and a base's tracked repos are discovered from the git clones on its volume rather than a persisted sidecar file. Drops the `kb base repo` and `kb base ignore` commands and the `kb-server.json` bootstrap manifest.

## 1.2.2

### Patch Changes

- Remove unintentional flags that were never meant to ship: `--type` and `--limit` on `kb query` (CLI parsing and help, remote client forwarding, HTTP query request fields, OpenAPI schema, and the `kb_query` MCP tool input), and `--type` on `docs generate` (the doc type is now always classified from the prompt). Fact retrieval uses the server-side defaults. The separate `docs list`/`docs generate`/`facts`/`logs` `--limit` options and `graph node --type` are unchanged.

## 1.2.1

### Patch Changes

- c204d60: Fixed small eval test issue.

## 1.2.0

### Minor Changes

- Split GitHub release artifacts and versioning for `@kb/client` / `@kb/server`; shared release-uninstall helpers and env-only client configuration (`KB_HOST`/`KB_PORT`, base state under `~/.kb/state/`).

### Patch Changes

- Split uninstall: client-only vs `kb-server uninstall --purge`.
- Fix TUI bundle esbuild banner, run telemetry token counts, and query pipeline logging.
- Connection-context formatting for remote-only client workflows; env-only configuration messaging.

## 1.1.4

### Patch Changes

- Standardize the default kb-server listen port to 38117 (CLI, Docker, client fallback, eval harness).

## 1.1.3

### Patch Changes

- Add `KB_QUERY_TIMEOUT`, fix `/healthz` readiness during bootstrap, and restore remote `kb query --trace`.

## 1.1.2

### Patch Changes

- Fix client/server split gaps: forward `--type`/`--verbose` on remote `kb query`, let the TUI chat run against a remote server without a local base or LLM key, stop nagging about a missing local API key in remote mode, and correct the server-side `kb graph --base` argument handling so it targets the requested base.

## 1.1.1

### Patch Changes

- Standardize boolean env vars to `true`/`false` only; bundle JS deps in CLI/server builds so global install resolves runtime modules.

## 1.1.0

### Minor Changes

- Route all kb commands through kb-server REST: POST /v1/admin/cli for init/scan/docs/facts/graph/logs/publish/base; client remote dispatch by default.

## 1.0.0

### Major Changes

- 1.0.0 client-server split: `kb` CLI/TUI client, `kb-server` daemon, `@kb/core` shared domain. Remote query/chat over REST+SSE; `kb server` subcommand removed.

## 0.22.0

### Minor Changes

- Split kb into client-server monorepo packages; remote CLI query/chat over REST+SSE; kb-server daemon binary and admin routes.
