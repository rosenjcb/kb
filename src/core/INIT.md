---
type: "Pipeline"
title: "KB Init Pipeline"
description: "How kb init and kb scan bootstrap and refresh a multi-repo knowledge base through the per-repo scan phases."
resource: ./src/core
tags: [init, scan, ingest, batching, performance]
timestamp: 2026-06-21T00:00:00Z
---

# KB Init Pipeline

`kb init` bootstraps a knowledge base from **one or more git repositories** — at least one `--git` remote is required (local-directory indexing has been removed). In interactive mode it first collects user input upfront — base name and at least one git URL — then clones each repo into `~/.kb/sessions/<base>/repos/<slug>/` and runs the multi-phase scan **per repo**: **`read-inputs`** (README-like docs), **`code-index`** (deterministic AST indexing into `facts` + `fact_edges`), **`document-facts`** (sentence facts from markdown sources; OKF frontmatter is stripped first, and a doc's `resource:` scopes which exported symbol each segment anchors to), **`import-docs`** (one verbatim original SQLite doc per discovered markdown file), and **`write`** (persist docs; with **`kb scan`** this stage also plans/applies claim mutations). Each fact records its origin repo in the **`git_repo`** column.

All repos fold into **one connected graph**. After the per-repo loop, an **integration-ingest** reconciliation pass bridges the subgraphs by linking facts across repos on real integration signals — `package.json` dependencies, cross-repo symbol imports, and `.env`/service references — producing cross-repo `fact_edges` (`depends_on_repo`, `cross_repo_symbol`, `references_repo`). This runs at the end of `kb init`, after **`kb scan`**, and after auto-sync. Use **`kb scan`** to pull + re-index every tracked repo and rebuild the cross-repo links.

In the TUI, init/scan progress is rendered as a dedicated live status line instead of transcript history. Any phase that iterates over a collection of files, docs, facts, claims, or mutations emits incremental progress while that collection is being processed; only atomic operations stay start/finish-only. Progress lines include counts and, when useful, the current item. The long-running deterministic phases also yield cooperatively to the event loop between batches so the terminal can repaint and interrupts remain responsive during large scans.

## Input Collection

```mermaid
flowchart TD
    A[kb init] --> B[collectSourceFiles]

    B --> B1["Fixed candidates\n(README, CLAUDE, AGENTS, …)"]
    B --> B2["Top-level *.md files\n(up to 8 total)"]
    B1 & B2 --> D[sourceFiles\nRecord<path, content>]

    D --> F[InitContext]
```

- `sourceFiles` — human-readable documentation files collected for **`import-docs`** (verbatim originals) and for **`document-facts`** / prompts.

## Init cycles

```mermaid
flowchart TD
    A[kb init] --> UQ[upfront questions]
    UQ --> UQ1["base name\ngit URL(s) (required)"]
    UQ --> CL[clone repos]
    CL --> R["per-repo loop:\nread-inputs"]
    R --> CI[code-index]
    CI --> MF[document-facts]
    MF --> IM[import-docs]
    IM --> W[write]
    W --> RC[integration-ingest\nreconciliation]

    CI --> CI1["AST indexing\n→ facts + fact_edges\n(git_repo set)"]
    MF --> MF1["Sentence segmentation\n→ facts import_doc"]
    IM --> IM1["One original doc\nper source file"]
    W --> W1["SQLite upsert\n+ scan planner"]
    RC --> RC1["cross-repo fact_edges:\ndepends_on_repo,\ncross_repo_symbol,\nreferences_repo"]
```

## Write batching & scan performance

The deterministic phases (`code-index`, `document-facts`) are write-bound, not
compute-bound: on a monorepo the original cost was thousands of individual
autocommitted SQLite writes (one bundle per segment / per symbol, each touching
3–4 tables). The fix is **transaction batching**, not a redesign — the indexers
fold many `upsertFact` calls into a single SQLite transaction.

```mermaid
flowchart LR
    A[document-facts] --> T1["runInTransaction\n(whole-repo)"]
    T1 --> S["per-segment\nupsertFact ×N"]
    B[code-index] --> T2["runInTransaction\n(per source file)"]
    T2 --> F["per-symbol/edge\nupsertFact ×N"]
    F --> ST["code_file_state\nhash write\n(OUTSIDE txn)"]
```

Invariants:

- **`document-facts` ingest wraps the entire repo's files in one
  `SqliteKbIndexer.runInTransaction`** (`src/core/scan-fact-ingest.ts`). Do not
  reintroduce per-segment autocommit — it was the dominant scan cost.
- **`code-index` wraps each source file's facts in a per-file
  `runInTransaction`** (`tree-sitter-indexer.ts`).
- **`runInTransaction` is re-entrant** via `transactionDepth` — a nested call
  joins the open transaction instead of issuing a second `BEGIN`.
- **`code_file_state` (per-file content hash) is written outside the fact
  transaction**, so a rolled-back fact batch never marks a file as indexed.
- **The `write` phase batches every doc upsert in one
  `SqliteDocumentWriter.runInTransaction`** (`init-cli.ts` `writeDocs`) instead of
  autocommitting per document. Original docs each write a single `original_docs`
  row and skip fact re-indexing (see *Facts extracted from written documents*),
  so this phase is cheap relative to `code-index` / `document-facts`.
- **Per-segment symbol anchoring stays two-tier**: OKF `resource` scope first
  (candidate symbols loaded once, token-overlap scored in memory via
  `scoreSegmentInScope`), then the global FTS nearest-symbol fallback
  (`findNearest`) only when no resource scope resolves.
- **Segmentation granularity is preserved**: `segmentMarkdownForFacts` defaults
  to `minSegmentLength=8` with no merging; scan ingest calls it with no options.
  Coarse paragraph merging (`mergeShortSegmentsBelow`) exists as opt-in only.

### Tried and reverted (do not redo without re-proving quality)

These were attempted for extra speed and reverted because they changed
graph/retrieval behavior while the structural DB stayed otherwise identical:

| Experiment | Why reverted |
|---|---|
| Defer `rebuildFactGraph` to a single post-ingest batch | Changed concept/edge graph; `rebuildFactGraph` stays per `upsertFact` |
| Cache a single global symbol matcher, drop the per-segment FTS fallback | Hurt retrieval anchoring; FTS fallback retained |
| Coarsen scan segmentation by default (merge short prose) | Reduced retrieval granularity; made opt-in instead |

### Build-under-test benchmark

Speed claims are measured by indexing the **same target snapshot** with two
different `kb` binaries (main build vs feature build), not by changing the target
repo. Latest run: ~24% faster init on the kb self-check, ~46% on raylib
(`db0870f`), with fact/doc/code-fact/docs counts identical across builds. Headline
numbers live in `research/tables/results.tex` (see `research/README.md`).

## Upfront Questions

Before the scan begins, interactive `kb init` (no `--base`, not `kb scan`, not `--non-interactive`) asks two questions in order:

| # | Prompt | Skipped when |
|---|---|---|
| 1 | Base name | `--base` provided or resuming checkpoint |
| 2 | Git URL(s) — at least one **required** | `--base` provided, `--git` provided, or resuming |

Git URLs are mandatory; there is no blank-to-local option and no fact-category prompt. Each URL may carry an inline `#branch`; the `--branch` flag sets the default branch for repos that omit one (default `main`). `/cancel` at any prompt aborts and returns to the chat session.

## Multi-repo clone + index

After the upfront questions, each `--git` repo is cloned into `~/.kb/sessions/<base>/repos/<slug>/` and recorded in `meta.json`'s `repos` array (`{ gitUrl, gitBranch, slug, dir, lastSyncedSha, lastSyncedAt }`). The per-repo loop runs `read-inputs → code-index → document-facts → import-docs → write` against each clone, tagging every fact with its `git_repo` origin.

## Integration-ingest reconciliation

Once all repos are indexed, the reconciliation pass folds the per-repo subgraphs into one connected graph. It links facts across repos on real integration signals:

- `package.json` dependencies (repo A depends on repo B's package)
- cross-repo symbol imports
- `.env` / service references

These emit bridge `fact_edges` of types `depends_on_repo`, `cross_repo_symbol`, and `references_repo`. The pass runs at the end of `kb init`, after `kb scan`, and after auto-sync.

## Document Provenance

Documents are routed by provenance via the `is_original` flag:

| `is_original` | Lane |
|---|---|
| `1` | Originals — **frozen snapshots** of source files (we do not rewrite or “correct” them in the KB pipeline) |
| `0` | Autogenerated — the **curated layer** we refine for retrieval and demos; may overlap originals on purpose |

## Title Conventions

| Context | Rule | Example |
|---|---|---|
| Autogenerated docs | Cap Every Word (`toTitleCase`) | `"Project Overview"` |
| Original/source docs | Basename as-is (`basenameTitle`) | `"CLAUDE.md"` |

## Facts extracted from written documents

When **derived** documents are persisted (the curated/autogenerated layer, or any path using **`SqliteDocumentWriter`** that writes non-original docs), the writer **indexes candidate facts** from the document body (deterministic sentence segmentation with OKF frontmatter stripped first, length filters, and capped inserts into the **`facts`** table). That is **incremental** fact growth alongside init; see **`facts-architecture.md`** §2 / §7 for the full ingest model.

**Original/source docs are excluded from this pass.** Their facts already come from the dedicated **`document-facts`** ingest (`scan-fact-ingest.ts`), which anchors triplets to AST symbols and namespaces `source_ref` as `path#sN`. Re-segmenting them again in the `write` phase was redundant churn — and it overwrote that richer `source_ref` with a bare doc-id, silently breaking per-file fact tombstoning on rescan. So `SqliteDocumentWriter.writeDocument` skips fact extraction when `isOriginal` is set; only the verbatim `original_docs` row is written.

## Code-derived facts (AST-only)

Source code facts come **only** from deterministic AST indexing (`TreeSitterIndexer`) during the **`code-index`** cycle. Supported languages get symbol facts and structural edges in `facts` / `fact_edges`. Languages without a wired WASM grammar are **not indexed** — there is no LLM fallback.

See **Language Support** below for the current AST matrix and the removed fallback list.

### One indexer

| Indexer | Files | When it runs |
|---|---|---|
| `TreeSitterIndexer` (`src/tools/tree-sitter-indexer.ts`) | All AST-able + text/config files | Always; uses WASM grammars via `web-tree-sitter` |

Every language — including TS/JS — goes through `TreeSitterIndexer`. It parses **one file at a time** (a single WASM syntax tree resident at once, freed via `tree.delete()` after each file), so peak memory is bounded by the largest file rather than the whole project graph. The earlier `TsMorphIndexer` loaded the entire TypeScript program (all source files + the type-checker dependency graph) into memory for a single pass, which dominated `kb init` memory and could OOM large repos. For TS/JS the tree-sitter path now also emits the constant-value, non-exported-constant (`defined_in`), and `EXTENDS`/`IMPLEMENTS` facts that previously only ts-morph produced (extracted by node navigation rather than the type checker).

### File handling by extension

`TreeSitterIndexer` uses an explicit **allowlist** — not a denylist:

- **AST-able** — extensions in `EXT_MAP` (`src/tools/tree-sitter-indexer.ts`): Go, TS/TSX, JS/JSX, Python, Rust, Ruby, Java, C/C++, C#, CSS, Bash, PHP, Scala, HTML, etc. → file node + symbol nodes + import/export edges where queries exist
- **Text/config** (`.md`, `.yaml`, `.json`, `.toml`, `.sql`, `.tf`, etc.) → file node only, `language='text'`, no symbols
- **Everything else** (images, binaries, lock files, compiled artifacts) → silently ignored

WASM grammars ship in `tree-sitter-*` npm packages — no native compilation, all platforms.

### What gets written

- **`facts`** (`source_kind='import_code'`) — one fact per exported symbol (`"Foo is a Class exported from src/foo.ts"`) with `source_text` set to the raw declaration (capped at 1500 chars)
- **`fact_edges`** — structural edges: `IMPORTS_FILE`, `EXPORTS_SYMBOL`, `EXTENDS`, `IMPLEMENTS`
- **`code_file_state`** — per-file content hash for incremental skip on re-run

### Incremental behaviour

The indexer stores a `content_hash` (and the extractor name) per file in `code_file_state`. On re-run (including `kb scan`), files whose hash hasn't changed **and** were indexed by the same extractor are counted as `skipped` and not re-processed. Only changed or new files — or files left behind by the legacy ts-morph extractor — are re-indexed.

To keep the TUI responsive, the deterministic ingest/index loops yield back to the Node.js event loop between batches. That lets progress updates paint incrementally and gives `Ctrl-C` / terminal interrupts a chance to land between chunks instead of waiting for an entire repo walk to finish.

## Language Support

One pipeline indexes source code: **code-graph** (`TreeSitterIndexer`), deterministic AST-based.

| Language | Extensions | Code-graph (AST) |
|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | yes — TreeSitter |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | yes — TreeSitter |
| Python | `.py` | yes |
| Go | `.go` | yes (uppercase-export convention) |
| Ruby | `.rb` | yes |
| Java | `.java` | yes |
| Rust | `.rs` | yes |
| C / C++ | `.c` `.h` `.cpp` `.cc` `.hpp` … | yes |
| C# | `.cs` | yes |
| PHP | `.php` | yes |
| Scala | `.scala` | yes |
| Bash | `.sh` `.bash` `.zsh` | yes |
| CSS | `.css` | yes (selectors) |
| HTML | `.html` `.htm` | yes (id elements) |
| Swift | `.swift` | **no** — no tree-sitter WASM grammar |
| Kotlin | `.kt` `.kts` | **no** — `tree-sitter-kotlin` is native-only |

Code-graph import/export edges: TS/JS have full import resolution; Go uses uppercase-initial convention; Python/Rust/Ruby/Java/C/C#/PHP/Scala/HTML extract exports but not imports (except Ruby `require` and PHP `require`/`include`).

**Text-only** (file node, no symbols): `.md`, `.yaml`, `.json`, `.toml`, `.sql`, `.tf`, `.proto`, `.graphql`, `.scss`, `.xml`, extensionless files (Makefile, Dockerfile).

**Ignored entirely**: images, binaries, lock files, compiled artifacts.

To add a language to code-graph: install `tree-sitter-<lang>`, add to `LANG_CONFIGS` + `EXT_MAP` in `src/tools/tree-sitter-indexer.ts`.

### Removed LLM code-facts fallback (historical)

Before removal, languages **without** AST support could be indexed via an LLM semantic pass (`code-fact-extract.ts`, prompt `code-fact-extract.md`). That path is **gone** — no AST module means the language is skipped.

**Languages actually crawled for LLM fallback** (allowlist `SOURCE_CODE_EXTENSIONS` in `init-cli.ts` at removal):

| Language | Extensions | Notes |
|---|---|---|
| Swift | `.swift` | No WASM tree-sitter grammar available |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` has no WASM build |

**Not LLM-fallback targets** (despite labels in the extractor's internal `LANG_BY_EXT` map): TypeScript, JavaScript, Python, Go, Ruby, Java, Rust. Those extensions were excluded from the crawl because AST indexing already handled them — the LLM pass never ran on them in production.

**How the fallback worked:** `crawlSourceCode()` walked the repo for the extensions above (up to 200 files, 400 chars/file), then one LLM call per file produced `{ module_summary, facts[] }` rows as `source_kind='import_code'`. Incremental rescans tracked file hashes in `code-facts-manifest.json`.

## Configuration Constants

| Constant | Value | Purpose |
|---|---|---|
| `MAX_SOURCE_SIZE` | 20 000 chars | Per-file cap for documentation files |
| `INIT_SOURCE_SHARD_MAX_FILES` | (see code) | Max shards when expanding |
| `INIT_SOURCE_SHARD_MAX_CHARS` | 8 000 chars | Per-shard content cap |
