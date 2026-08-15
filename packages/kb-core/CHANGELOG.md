# @kb/core

## 2.0.1

### Patch Changes

- Absorb transient embedding-provider errors (429 rate limits, 5xx, network blips) in the Gemini embedder with bounded exponential backoff that honors `Retry-After`, so a busy provider slows a run instead of crashing it — while still failing fast once the retry budget is spent. Eval reindexing now treats embedding as mandatory (`requireEmbeddings`), failing the init loudly rather than publishing a lexical-only index that scores nothing.

## 2.0.0

### Major Changes

- Retire the sentence-level fact graph. Index whole markdown documents and AST code symbols linked by flat doc_code_links; retrieve with hybrid FTS + embeddings (RRF) instead of multi-pond BFS. Existing bases must reindex (schema v21).

## 1.6.5

### Patch Changes

- Make answer citations source-centric: cite the ranked _files_ (with their fact
  subjects folded in as symbols) instead of one entry per fact. A single canonical
  `groupSources` model in `@kb/core` now backs every surface (HTTP demo, Slack,
  CLI, MCP, REST), so they no longer drift. This fixes repeated files, drops
  non-openable refs (`fact://` ids, `ast:edge:<sha>`/`ast:import:<sha>` hashes that
  surfaced as bogus `edge:<sha>` filenames), unifies blob-link construction, and
  lets a bare-`HEAD` clone still produce Slack links.
- Lean agent query payload by default: `{path, symbols?}` sources without fact dumps;
  full evidence only when `verbose: true` (REST + MCP).
- Stop citing document-id slugs and synthetic integration refs as openable source paths.

## 1.6.4

### Patch Changes

- Centralize Gemini thinkingBudget defaults (GEMINI_THINKING_BUDGET / 1024 when reasoning) so generateContent never omits thinkingConfig on Gemini 3. Count thoughtsTokenCount toward usage.outputTokens so telemetry/eval out= matches billed output.
- Split CamelCase in entity alias normalization so prose like "tree-sitter indexer" lands on harvest names, and surface scope/lanes on retrieval detail.
- Expand queries into ontology-typed inquiry lanes, and stop ordinary English words from resolving to entities.

  When stage-0 scope inference resolves a question to an entity, the query pipeline now
  derives deterministic sub-queries from the entity graph — its owner, its parent domain,
  its dependencies, and mechanism probes conditioned on entity kind — and hands them to
  the deep retrieval fan-out. Lanes need no LLM call and are not gated on query length,
  so long vague questions get targeted probes too. Questions that resolve to no entity
  keep the existing LLM expander unchanged. Lanes follow the registry's existing
  `KB_ENTITY_SCOPE` switch.

  Two ontology gaps that capped what lane targeting could do:

  - Aliases spelled like ordinary English words captured ordinary prose. "The _role_ of
    the tree-sitter indexer" resolved to a Prisma `Role` enum, landed `very_confident`,
    hard-pruned retrieval to the database schema, and short-circuited the LLM classifier
    that would have caught it. A single-token alias that is a common English word is now
    distinctive only when the query echoes its capitalization (`Role`, not `role`); an
    all-lowercase common word never is. Non-distinctive matches are still reported — they
    just stop deciding scope, and the question reaches the classifier instead.
  - `owned_by` was emitted nowhere, and no harvester could produce a `team` entity for it
    to point at, so the ownership lane was unreachable. Backstage `spec.owner` is now
    harvested as an `owned_by` edge with the named owner minted as a `team`, accepting the
    full entity-ref form (`group:default/name`). A service catalog is the only place a
    repository declares accountability; nothing else infers ownership.

## 1.6.3

### Patch Changes

- Harvest real relationship edges, and stop serving stale bases.

  The entity registry was a bag of names, not a graph. `owned_by` and `depends_on`
  had no writer anywhere in the codebase, the `part_of` edges that were emitted
  pointed at workspace/Gradle/solution roots that nothing harvested (so they were
  dropped silently), and tier-4 entities — the bulk of every registry — had no
  edges at all.

  - Harvest the container an edge names: the workspace root package, the Gradle
    root project, and the `.sln` solution are candidates in their own right.
  - Emit `depends_on` from the dependency lists every package harvester already
    parsed for the kind rubric and then discarded. Third-party targets are counted
    as external rather than minted as stub entities.
  - Derive containment in the `entity-index` cycle: each candidate is `part_of` the
    nearest package owning its source file, and each package is `part_of` the repo.
  - Resolve edge endpoints against the whole base and report `edgesWritten` /
    `edgesExternal` / `edgesDropped` in the cycle result, the scan progress line,
    and `eval-entities`. An unresolvable structural endpoint is no longer silent.
  - Stamp an extraction pipeline version per repo and re-index in `auto-sync` when
    it is behind, so a repo with no new upstream commits still picks up harvester
    changes instead of serving a pre-change index indefinitely.
  - Scope `/v1/admin/cli` to the base the request selected. The client sends
    `--base` as the `X-KB-Base` header, which that route ignored, so admin commands
    answered from the server's default base no matter which base was asked for.

## 1.6.2

### Patch Changes

- Remove hand-assigned numbers from the harvester and express every assessment as
  a label.

  **Harvest rules carry no weights.** Every `kind_rule` and `source_pattern` had a
  `confidence` constant typed in by its author, read by nothing but one debug line
  in `kb entities`. Removed from YAML, code, and schema; config load now rejects
  `confidence` / `weight` / `score` on any rule, so a rule too weak to act on gets
  deleted rather than discounted. `classifyPackageKind` / `classifyFromSignals`
  return an `EntityKind` instead of a `{ kind, confidence }` pair, and
  `EntityRegistry` drops the confidence arguments plus the never-passed `weight` on
  `addEdge`.

  **Candidates record real provenance.** `sourceKind` was typed as the literal
  `'manifest'` and hardcoded at all 27 emit sites, including those inside
  `pattern-engine.ts` that are by definition not manifests. It now carries the
  extraction path taken: `manifest` for names parsed from a file that declares
  identity, `source-pattern` for names found by a YAML `source_pattern` run over
  ordinary source.

  **Retrieval assessments are categorical.** A `confidence` float came out of a
  hand-tuned blend and four modules each re-interpreted it with their own
  cut-point: chat refused below `0.45`, the MCP serializer warned below `0.7`, the
  checkpoint orchestrator used `0.55` / `0.45`, the rescan writer `0.6` / `0.65`.
  New `core/evidence-label` defines one ordered vocabulary (`none` / `weak` /
  `moderate` / `strong`); the category is decided once, where the metrics are
  known, and consumers compare labels. Both live cut-points — the chat refusal
  floor and the MCP verify note — are reproduced exactly, pinned by a test that
  sweeps the metric space against the original formula.
  `IntentResult.confidence` → `evidence` across REST/MCP payloads, checkpoints,
  trace lanes, and telemetry; `KB_CHAT_RETRIEVAL_MIN_CONFIDENCE` and
  `KB_INTENT_LOOP_CONFIDENCE_THRESHOLD` take labels, falling back to the default
  rather than silently disabling the gate.

  **Facts carry an evidence kind, not a confidence float.** Per-fact `confidence`
  was a per-write-site constant standing in for _what kind of fact this is_ — 0.3
  an import edge, 0.7 an `extends` edge, 0.6 a doc sentence. Facts now store a
  label (`incidental`, `contextual`, `descriptive`, `declarative`, `definitional`,
  `curated`) and the ranking weight lives in one table in `core/fact-evidence`.
  The MCP `upsert_fact` tool takes the label as an enum, so an extractor can assign
  it semantically. Because the label is what is stored, the weights can be retuned
  and re-measured without reindexing.

  Migrations 18–20 drop the entity-registry weight columns, recreate the retrieval
  telemetry tables with `evidence TEXT`, and map existing `facts.confidence` values
  back through the constants they were written with.

  Behavior is unchanged throughout: harvest produces the same entities, aliases,
  edges, and collisions; every migrated fact resolves to the exact ranking weight
  it had before; and both retrieval gates keep their existing boundaries. The
  weights are inherited guesses, not results — they are what the ablation harness
  (#207) exists to test.

## 1.6.1

### Patch Changes

- Never present a failed LLM call as an answer. Provider errors during answer synthesis (rate limit, spent credit balance, bad key, 5xx, timeout) and empty completions were swallowed by a bare `catch`, so an outage reached callers as `answer: null` with the note "No synthesized answer was produced — open the cited sources directly" — indistinguishable from a knowledge base with nothing to say, on a `200 OK` recorded as a successful RunReport. Provider calls now throw a classified `LLMApiError` (`insufficient_credits` is detected by message, since Anthropic reports it as `400` and OpenAI as `429`), synthesis records a structured `answerError` (`stage`/`kind`/`message`/`provider`/`status`/`retryable`) that `/v1/query` and `kb_query` serialize with the failure leading `notes`, `kb query` prints the reason and exits non-zero instead of printing a bare source list and exiting 0, and the sampled feedback ask is skipped so an outage is never scored as answer quality. Retrieval results are preserved and `status` stays `accepted` throughout, so source handling downstream is unchanged. Best-effort stages (scope inference, graph rerank, sufficiency judge, curation) still fail safe but report on `retrieval.degraded[]` rather than vanishing; the fact curator no longer tells the synthesis prompt that evidence was "focused to N facts" when its judge never ran; and a chat turn whose model returns no text emits an `error` event instead of the canned "I don't have enough information to answer that."

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
