# kb

## 1.0.1

### Patch Changes

- c204d60: Fixed small eval test issue.

## 1.0.0

### Major Changes

- 1.0.0 client-server split: `kb` CLI/TUI client, `kb-server` daemon, `@kb/core` shared domain. Remote query/chat over REST+SSE; `kb server` subcommand removed.

## 0.21.0

### Minor Changes

- Require git remotes for `kb init`: prompt for URLs first, default base names from the first remote, and stop writing `.kb` markers into the caller's working directory.

## 0.20.0

### Minor Changes

- 60d2d98: Real embeddings for semantic fact scoring, plus env-gated retrieval ablation knobs.

  The deep-retrieval "semantic" score was `buildDeterministicVector` — a SHA256 hash of the
  whole string — which is a lexical fingerprint, not meaning: relevant facts that use different
  words than the question (e.g. a question about "directories/paths" vs a doc about
  "basename / dir-only / repo root") scored as noise and were buried below the curator cap.

  This adds a pluggable `Embedder` (`src/core/embeddings.ts`): a default **local, on-device**
  backend (`@huggingface/transformers`, all-MiniLM-L6-v2, optional dependency, lazy-loaded, no
  API) and an opt-in hosted Gemini backend (`KB_EMBEDDER=gemini`). `SqliteKbIndexer` gains
  `embedAllFacts()` (batch re-embed at ingest) and a cached real query vector used by
  `semanticFactScores`; everything falls back to the deterministic vector when no embedder is
  available, so behavior is unchanged offline.

  Also adds default-off env knobs for one-lever retrieval diagnosis via `kb query --trace`:
  `KB_ABLATE_NO_EXPANSION`, `KB_ABLATE_JUDGE_CAP`, `KB_ABLATE_RAW_SCORING` + `KB_ABLATE_RAW_Q`,
  and `KB_ABLATE_CURATOR_RAW_Q`.

## 0.19.0

### Minor Changes

- Add an opt-in deep query trace. `kb query --trace` (or `KB_QUERY_TRACE=true`) writes a full content dump of the deep facts loop to `~/.kb/traces/<traceId>.json` — every fact the walk discovered (with score and content), the per-pass decision breadcrumbs, the facts cut below the score floor, and the facts the curator kicked out with the judge's reason. It is off by default, written out-of-band, and never fed into synthesis or the eval score, so you can replay a query offline and see exactly what it found and what it dropped.

## 0.18.0

### Minor Changes

- Persist a per-hop retrieval trace on `kb query` telemetry (`RunReport.retrieval`: passes, graph hops, ponds, stop reason, per-pass loop lines, checkpoints, and the curator's kept/dropped/dropped-fact-ids). The eval harvest joins this with each question's stage token/time split to emit a `query_timeline` and a `timeline_summary` diagnosis (thinking-vs-synthesis token share, retrieval-time share, curator drop rate, slowest question) so a run's cost concentration is visible without re-instrumenting.

- Bound the fact curator's judge input (`maxJudgeCandidates`, default 100). Previously the judge prompt listed every candidate, so on large pools the fixed-size verdict JSON truncated, threw, and dropped the curator into a fail-safe that returned the **full unpruned pool** to synthesis — flushing hundreds of facts into the prompt exactly where pruning mattered most. Now the top candidates by orchestrator rank are judged and the tail is hard-dropped deterministically; the error fail-safe is likewise capped instead of returning the whole pool.

## 0.17.0

### Minor Changes

- Make query/chat synthesis conversational and well-formatted instead of a flat fact dump.

  - Both synthesis prompts (the one-shot `kb query`/`/v1/query` path and the `runChatSynthesis`
    loop behind `kb chat`, `/v1/chat`, and Slack) now drop the "plain prose, never cite" mandate:
    they structure multi-part answers (headings/bullets/tables), bold key terms, and weave concrete
    identifiers (files, functions, settings) inline so answers are scannable and verifiable.
  - The chat loop now reflects-and-decides after each `query_kb` result — querying again from a
    distinct angle when a material part is unaddressed — so non-trivial questions actually loop
    rather than collapsing to a single retrieval.
  - The fact curator's self-assessment (`{evaluated, dropped, requeried, sufficient}`) is now surfaced
    to synthesis as a short "research notes" framing block instead of being discarded out-of-band, so
    the model writes from a thesis (and knows which gaps retrieval could not close).
  - Eval: the Usefulness rubric axis now rewards actionable, well-organized answers for whoever asked
    (developer, SME, support, or end user) and penalizes undifferentiated walls of text; two suite
    reference answers restyled to the structured form.

## 0.16.0

### Minor Changes

- Index every language (including TypeScript/JavaScript) with a single tree-sitter
  AST platform and retire the ts-morph indexer. ts-morph loaded the entire
  TypeScript program — all source files plus the type-checker dependency graph —
  into memory for one pass, which dominated `kb init`/`kb scan` memory and could
  OOM larger repos. Tree-sitter parses one file at a time (a single WASM syntax
  tree resident at once, freed after each file), so peak memory is bounded by the
  largest file rather than the whole project graph — indexing this repo now peaks
  well under 200 MB. The TS/JS path keeps full parity: constant values in fact
  text, `defined_in` facts for top-level non-exported constants, and
  `extends`/`implements` structural edges. Files left behind by the old ts-morph
  extractor are re-indexed on the next scan.

## 0.15.1

### Patch Changes

- Adopt spec.md behavioral specs (FR/TC tables), test `[TC-N]` tags, and a CI traceability gate.

## 0.15.0

### Minor Changes

- Overhaul the query/synthesis relevance path:

  - **Fact curator** (`src/tools/fact-curator.ts`): a judge-in-the-loop replacement for the post-retrieval relevance filter. It deterministically auto-keeps high-overlap facts, asks a single structured LLM verdict (`{keep, gaps, sufficient}`) keyed on the raw user question, hard-drops everything off-topic (no 15% floor), and issues bounded shallow re-discovery for gaps so aggressive dropping stays safe. Fails safe on errors, never returns an empty set, and records decisions out-of-band on `retrieval.curation` — never injected into synthesis context. Removes the dead chat session-pool mechanism (`chat-conversation.ts`).
  - **Natural-language answers**: synthesis evidence is no longer framed as enumerated, citable items — the "Fact N … (id=…)" headings are gone, and both synthesis prompts forbid inline "(fact 1)" references and trailing "Sources/Citations" lists. Answers are plain prose; provenance stays in metadata.

### Patch Changes

- Auto-export harvest eval metrics to research/tables/results.tex and clarify eval summary labels (suite vs K/N condition).
- Expose live bootstrap progress in server indexing responses and mirror that status through Slack while the first index build completes.

## 0.14.1

### Patch Changes

- Start `kb server` before first-boot indexing completes, expose indexing state on `/healthz`, and return temporary indexing errors from query/chat/MCP until the initial background build finishes.

## 0.14.0

### Minor Changes

- Add server-side run report capture so `kb logs` surfaces server traffic.

  When kb-server handles requests to `/v1/query`, `/v1/chat`, `/mcp`, and `/slack/events`, it now writes `RunReport` entries to the same NDJSON log store used by CLI telemetry. `kb logs list`, `kb logs show`, and `kb logs compare` all surface server runs naturally alongside CLI runs. Reports include command (e.g. `server.query`), base, request ID, duration, and status. Health-check probes are excluded to avoid noise. `defaultLogsDir()` now respects `KB_HOME` so container/server deployments write to the correct path.

## 0.13.1

### Patch Changes

- Fix kb-server's scheduled reindex behavior, restore Docker Slack env wiring, and simplify the changeset workflow so `changeset:version` is the single apply path.

## 0.13.0

### Minor Changes

- Add `POST /slack/events` webhook handler with HMAC verification, event dedup, bot-loop guard, and thread-reply chat routing; expose `reindexing` flag on `GET /healthz`.

## 0.12.0

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

## 0.11.1

### Patch Changes

- 3af609d: Improve kb server startup ergonomics by making `server:start` run locally, forwarding optional GitHub tokens to Docker and git sync, and clarifying Docker workflows in the server docs.

## 0.11.0

### Minor Changes

- df35234: Add `kb server start`: HTTP API (`/v1/query`, `/v1/chat` SSE, `/healthz`) with optional MCP at `POST /mcp` via `--with-mcp`. `kb-server` package: Docker image, WireMock integration suite (`packages/kb-server/http/server.http`), and compose wiring.
- a23e85a: Make `kb server start` self-bootstrapping and `kb init` idempotent so a server node can be
  launched in a fresh container without the manual `kb init` / `kb base` flow.

  - `kb server start` now resolves a bootstrap plan (base + git repos + ignore patterns) from,
    in precedence order, `--git`/`--base`/`--branch`/`--bootstrap` flags, env vars
    (`KB_SERVER_BASE_NAME` / `KB_SERVER_BASE_GIT_REPOS`, with `KB_BASE` / `KB_GIT_REPOS` as
    back-compat aliases), or a declarative `kb-server.json` manifest (which can express per-repo
    branches and ignore globs). On an empty volume it boot-builds the index from that plan; on
    a warm volume it reuses the persisted index for fast restarts but folds in any repo newly
    declared in the plan that the base doesn't yet track, so a node converges on its declared
    repo set without manual intervention.
  - `kb init` against an already-initialised base no longer re-runs the fresh-init pipeline
    (which clobbered `meta.json` and re-indexed from scratch). It now swaps to the existing base,
    re-syncs its tracked repos, and clones + indexes any newly-listed `--git` remotes, announcing
    the swap clearly in both the TUI and the CLI.

## 0.10.0

### Minor Changes

- Remove the `kb publish jekyll` command and the generated Jekyll docs site. Publishing now targets Notion only (`kb publish notion`). The `docs/` Jekyll site, the `jekyll-docs` GitHub workflow, and the `jekyll-sync`/`graph-reader`/`publish-jekyll` modules and their tests have been deleted.

## 0.9.2

### Patch Changes

- Speed up the `kb init`/`kb scan` write phase. Original/source docs no longer
  re-segment their content into facts when written to the SQLite store — those
  facts are already produced (with AST-anchored triplets and `path#sN` provenance)
  by the dedicated `document-facts` ingest pass. The doc writes are also batched
  into a single transaction instead of fsync-ing per statement. This removes the
  redundant per-segment fact churn that dominated the phase and also fixes a latent
  bug where the redundant pass overwrote the `source_ref` that per-file fact
  tombstoning relies on during rescans.

## 0.9.1

### Patch Changes

- Speed up scan doc fact ingest with batched writes, cached symbol matching, deferred graph rebuilds, and coarser scan chunks.

## 0.9.0

### Minor Changes

- Adopt the Open Knowledge Format (OKF) as the encouraged documentation standard.

  - Functional OKF support on ingest: `kb init` / `kb scan` recognize markdown docs with
    OKF frontmatter (a YAML block carrying a `type`) and skip the metadata block so it
    never leaks in as raw `key: value` facts, then index the document body exactly like
    any markdown. OKF docs get no special retrieval boost. Plain markdown is unchanged —
    kb stays format-agnostic and never rejects a non-OKF doc.
  - The bundled `kb:dump-context` agent skill now authors companion docs as OKF concept
    files (frontmatter + body) by default.
  - A doc's OKF `resource:` (when it resolves to a code file/dir via the
    `ast:<path>@<symbol>` convention) scopes each segment's anchor to that file/dir's
    exported symbols, instead of guessing against the global nearest-symbol FTS pool.
    Docs without a resolvable `resource` are unchanged.

## 0.8.0

### Minor Changes

- Add gitignore-style ignore patterns for scans. A base now stores an `ignore` list in its
  `meta.json` that is honoured on init and every rescan (`kb scan`, auto-sync). Manage it with
  `kb base ignore list|add|remove|set|clear`, and `kb init` prompts for patterns up front
  (skippable). A `.kbignore` file committed at a repo root is merged on top of the base's
  patterns at scan time. Patterns follow `.gitignore` semantics (anchoring, `*`/`**`/`?` globs,
  trailing-slash dir-only, `!` negation).

  Adopt a noun-then-verb command style (like `git remote …`) for base-scoped repo management:
  `kb base repo list`, `kb base repo add <url[#branch]>`, and `kb base repo remove <url|slug>`.

## 0.7.0

### Minor Changes

- Remove 150-fact cap from kb query. The research loop now runs until all facts are exhausted or a sufficiency threshold is reached, instead of stopping at a hard ceiling.

## 0.6.0

### Minor Changes

- Improve TUI init progress: show repo slug and a bold progress bar above history, with an idle spinner before the first update. Init progress lines now include `@ repo` when indexing multi-repo bases; merge default-branch clone handling from upstream.

## 0.5.0

### Minor Changes

- Multi-repo knowledge bases: a base now tracks one or more git repos and folds them into a single graph.

  - `kb init` requires at least one `--git <url>` (repeatable; supports inline `url#branch` and a `--branch` default). Local-directory init has been removed.
  - Manage a base's repos with `kb config list-repos` / `add-repo <url>` / `remove-repo <url|slug>`.
  - `kb scan` now pulls and re-indexes every repo a base tracks (it no longer reads the working directory); auto-sync syncs all repos.
  - Facts record their originating repo in a new `git_repo` column; a reconciliation pass bridges repos into one connected graph via package-manager, cross-repo symbol, and env/service references.
  - Retrieval is now repo-scoped: query expansion exhausts the landed repo's facts before walking the cross-repo edge tree. The fact-category/tags/topics system (and its Python clustering) has been removed.

## 0.4.1

### Patch Changes

- Fixed eval script using purgd command.

## 0.4.0

### Minor Changes

- dfa8079: Stream model **reasoning ("thinking") tokens as a transient loading bar** during query and chat. Any LLM interaction that opts in via the new `LLMCallParams.onReasoning` callback now enables provider thinking (Anthropic extended thinking, Gemini `includeThoughts`, OpenAI reasoning deltas, Ollama `think`) and surfaces the reasoning live as a self-replacing progress line that disappears the moment the real result arrives — including between iterations of the chat synthesis loop. Reasoning is never written to the permanent transcript. Wired into `kb chat` (TUI + CLI) answer synthesis and the `kb query` answer step; falls back transparently to the existing non-streaming path when a model can't stream reasoning.

## 0.3.0

### Minor Changes

- 2b1d118: Remove non-canonical CLI command aliases and fix the `kb sync` runtime.

  - Drop the duplicate aliases so only the canonical forms exist: `kb use` →
    `kb base use`, `kb default` → `kb base use --default`, `kb view`/`kb list` →
    `kb docs view`/`kb docs list`, and `kb init --rescan` → `kb scan`. The
    `--rescan`/`--apply` flags are no longer parsed from `kb init`.
  - Fix `kb sync` so it resolves and re-indexes git-URL bases correctly at
    runtime (auto-pull and re-index on new commits, no manual scan needed).
  - Refresh the root README and skill docs to reference the canonical commands.

### Patch Changes

- e2bef79: Restore a GitHub release on every push to `main`. Releases are now named after the current Changesets-managed version (e.g. `KB CLI v0.2.0 (build abc1234)`) and include the latest changeset notes from `CHANGELOG.md` in the body. Also fixes the release artifact name mismatch (`node22` → `node24`) that broke the `install-kb.sh` bootstrap installer.

## 0.2.0

### Minor Changes

- 771b16b: Introduce Changesets for semantic versioning. Version is now surfaced in the CLI banner, `--version` flag, TUI welcome screen, and research paper author block (with release date). GitHub Actions enforce a changeset file in every PR and automate version bump PRs and tagged releases on merge to main.
