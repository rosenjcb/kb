---
layout: default
title: howto guide for setting up a knowledge base in a
date: '2026-05-26'
kb_id: howto-guide-for-setting-up-a-knowledge-base-in-a
tags:
  - docs-generate
categories:
  - howto
---

## Introduction

KB is a local-first knowledge system built for AI-assisted development. It addresses the pain of maintaining a knowledge base by turning your codebase and documentation into a searchable, queryable system. By extracting structured facts, KB ensures that decisions, architecture details, and project context are always at your fingertips, allowing both AI agents and developers to retrieve the right context before making changes. The goal is to provide a knowledge base for free, as a side effect of your regular development work.

## Prereqs

*   **Node.js**: KB expects Node 22+ in the shell. Node 22 is installed by default.
*   **KB Tool**: For the first install, install `kb` from GitHub Releases on a fresh machine. For subsequent upgrades, use `kb sync`.

## Setup

To set up a knowledge base in your local repository:

1.  Navigate to your repository root:
    ```bash
    cd ~/{{YOUR_AWESOME_REPO}}
    ```
2.  Initialize the knowledge base using `kb init`. This command bootstraps a knowledge base from your repository. You can specify a base name, for example `dogfood`:
    ```bash
    kb init --base dogfood
    ```
3.  Walk through the chat-based wizard to create your knowledge base. During initialization, `kb init` performs several steps:
    *   Reads source files and collects repository inputs.
    *   Extracts document facts from markdown sources.
    *   Performs LLM fallback for source code facts if AST providers are unavailable.
    *   Prompts the user to define fact categories (named buckets for organizing retrieval). This step is interactive and skipped on `kb scan`.
    *   Imports original documents for each discovered markdown file.
    *   Persists documents and indexes candidate facts into the `facts` table.
    *   Performs deterministic AST indexing of every file in the repository, writing directly into `facts` and `fact_edges` in the `.kb-index.sqlite` database.
4.  The progress of `init`/`scan` is rendered as a dedicated live status line in the TUI.
5.  To refresh sources against an existing knowledge base after changes, use `kb scan`. Category prompting is skipped on rescan, preserving categories defined at init time. `kb scan` only re-extracts files whose `sha256` has changed.

All graph data, documents, chunks, and facts live in the `<base-dir>/.kb-index.sqlite` file.

## Query and Chat

Once your knowledge base is set up, you can query it and use chat mode to explore.

*   **Query**: Use `kb query` to ask questions. KB reads your code and documentation, extracts structured facts, and provides a fast, queryable knowledge base. Hybrid retrieval (SQLite full-text search + vector-style ranking) returns relevant documents even when query phrasing differs from stored facts.
*   **Chat Mode**: In chat mode, the InputBar border turns orange and the prompt becomes `you>`. Slash commands that are output-only (e.g., `/query`, `/facts`, `/graph`, `/docs list`, `/base`, `/config`) are intercepted at the TUI layer and display inline without involving the LLM loop.

## Doc generation

You can generate documents using the `kb docs generate` command.

*   Use the command with a prompt and specify the document type:
    ```bash
    kb docs generate "<prompt>" --type howto|introduction|reference|decision|runbook [--base <name>]
    ```
*   In chat mode, you can use the `/docs generate "<prompt>"` slash command for a guided doc-draft wizard.
*   LLM-generated documents produced by `kb docs generate` are stored in the knowledge base.

## References

- `kb init` bootstraps a knowledge base from a repo. — `fact://72b7398cbfcdb6ff`
- Does `kb init` produce a usable knowledge base from the current repo without manual surgery? — `fact://5315e301416d97b9`
- title: KB — Local-First Knowledge for AI Workflows — `fact://5a1f5031591fc500`
- `kb publish jekyll --base dogfood --dir docs/ --apply` (run from the repo root) syncs the dogfood knowledge base into this directory: — `fact://9c0d8f35bc9c22c6`
- It provides the VitePress-like shell (sidebar, local nav, search, dark mode). — `fact://0992d806fd2e6517`
- KB is a local-first knowledge system built for AI-assisted development. — `fact://02070fc8f9ffea32`
- **No local target directory:** repo URL resolves from suite YAML `repo_url`, with optional `--repo` override. — `fact://baebf9dd4ea2ce8e`
- **KB** is a local-first knowledge layer for development workflows. — `fact://2ab22c356b327726`
- As you build up your knowledge base, the graph gives you a structural view of how ideas connect — something the flat SQLite full-text index cannot express. — `fact://09cf7624680fd596`
- In-repo architecture notes for the boss/worker **task** tool, nested **`agentLoop`**, and related types. — `fact://7451735e282b7246`
- KB turns your codebase and docs into a searchable knowledge base: — `fact://b1abb8b771c0519f`
- 4) Query your knowledge base — `fact://d4ec62b351923875`
- | `<repo-leaf>-YYYY-MM-DD-HHmm` | Default disposable base from `eval-run.mjs`: **same string** as `~/.kb/evaluations/<run-name>/` (override with `--base`) | Ephemeral | — `fact://65e57bfe15405d91`
- If you use `kb`, you never have to "maintain" a knowledge base; it just happens. — `fact://5b34ee8b0425e7a2`
- * 🔁 **Refresh** — Re-scan after changes to keep the knowledge base current — `fact://4b88575bd95d3d0f`
- | `npm run eval:gen-doc` | `kb docs generate` smoke (introduction + howto) on `--base` (default `dogfood`); artifact under `~/.kb/evaluations/<run>/` | — `fact://8b8e305c340b2427`
- You are a knowledge base extractor. — `fact://fa8dea8d1a625fc9`
- 3. Set a knowledge base — `fact://f21189fef6ffd34f`
- | Autonomous open-ended tool use in SDK/programmatic context | `agentLoop` | — `fact://1dcc7358b2e4b130`
- 5. Query your knowledge base — `fact://0db9a23138a3abf6`
- **`agentLoop`** — low-level async generator for autonomous tool-calling. — `fact://17e2ae57e69e489b`
- howto introduction reference decision runbook — `fact://f3914f3d3c251da2`
- You are KB, a knowledge base assistant backed by a codebase knowledge graph. — `fact://e8703a636cf31610`
- - Default disposable **KB base** = **run folder basename** (`<repo-leaf>-YYYY-MM-DD-HHmm`, e.g. — `fact://71c56756a77b5d53`
- You decompose user questions into 1–4 focused retrieval queries for a codebase knowledge base. — `fact://3cdfbf0293cfe88d`
- It reads your code and documentation, extracts structured facts, and gives you a fast, queryable knowledge base — so context is always at your fingertips. — `fact://fdb0fc1213aff7eb`
- - CLI wording should make this explicit: these are knowledge-base cleanup operations, not codebase refactors. — `fact://72d6bb48c3389e1e`
- Guiding Principles — `fact://6adb6746835b80fd`
- **Knowledge base** — an effective base (`config.activeBase` or `config.defaultBase`), or an explicit `--base <name>` on commands that support it. — `fact://6230941ae00ec4c5`
- LLM-generated documents produced by `kb docs generate` and stored in the knowledge base. — `fact://8f99aff12302aba3`
- Local preview — `fact://19df9d4c775e4f95`
- KB gives that knowledge a home with a queryable structure — so your AI agent (or you) can retrieve the right context before making a change. — `fact://31050b3b91f8ca89`
- **Knowledge graph** — entities and relationships are extracted automatically, so you can ask "what depends on X?" and get a traversal, not just a keyword match. — `fact://1ab70fec00e2df62`
- `IMPORTS_FILE` only resolves **local** specifiers (`.` or `/` prefix). — `fact://8151c0aa9cffe174`
- Evaluate whether building and maintaining a `kb` knowledge base is materially useful for real development work, and whether a split workflow works better: — `fact://666c40d82a3ee10e`
- The LLM sees the full knowledge base. — `fact://60f93b9134d2c13c`
- The goal is simple: you get a knowledge base for free, as a side effect of doing your real work. — `fact://9202fa77364a5d78`
- - **Base resolution:** Most commands flow through `base-selection.ts`; missing base → `CLI_ERROR_NO_KB_BASE` (formatted by `cli-prerequisites.ts`). — `fact://ca9250b6e83cdbb3`
- kb docs list [--base <name>] [--limit <n>] [--output human|json] kb docs view <document-id> [--base <name>] [--output human|json] kb docs view --title "<exact title>" [--base <name>] [--output human|json] kb docs generate "<prompt>" [--type howto|introduction|reference|decision|runbook] [--limit <n>] [--base <name>] kb docs rename <document-id> "<new title>" [--base <name>] kb docs delete <document-id> [--base <name>] [--force] — `fact://b525137427027751`
- - prereqs: What must be true before starting (tools, access, versions)? — `fact://48811f2efa997528`
- - installs `Node 22` — `fact://d167fc82d9a07cc8`
- Flags: `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--hypothesis`, `--label`. — `fact://0f6519ac04e4f2ac`
- "type": "howto" | "introduction" | "reference" | "decision" | "runbook", — `fact://d702e5f92265188b`
- In the TUI, init/scan progress is rendered as a dedicated live status line instead of transcript history. — `fact://189dca2c7a534eae`
- **Future:** HDBSCAN-based auto-discovery (currently commented out in `src/cli/init-cli.ts`) will run before the manual step to suggest categories derived from the actual fact corpus. — `fact://27bf1035502778dc`
- It runs **input collection** (README-like docs + optional source-code crawl), **`document-facts`** (document facts from markdown sources), **`code-facts`** (LLM fallback facts for source code when AST providers are unavailable), **`fact-categories`** (interactive step: user defines named categories with descriptions, facts are then assigned via TF-IDF cosine similarity), **`import-docs`** (one verbatim original SQLite doc per discovered markdown file), **`write`** (persist docs; with **`kb scan`** this stage also plans/applies claim mutations), and **`ast-facts`** (deterministic AST indexing directly into `facts` + `fact_edges`). — `fact://1cd492d02546da1d`
- cd ~/{{YOUR_AWESOME_REPO}} kb && /init --base dogfood — `fact://4d581272a65e4aed`
- The only "process" is: keep moving forward, and let the knowledge base reflect reality as it changes. — `fact://d0e8b7359d4f3d9d`
- Howto checklist — `fact://21311ec68d1344b3`
- → file node + symbol nodes + import/export edges where queries exist — `fact://c2ee8391c50f7055`
- Override with `--base` if needed. — `fact://4e4feb62887e07bb`
- | `_data/navigation.yml` | Top nav bar | — `fact://14d9eaad035b2ada`
- - Do not embed secrets or repo-specific paths in skills; use `kb query` / base flags in examples. — `fact://be07d94ddedb413c`
- | `read-inputs` | Scan source files and collect repo inputs | `InitContext` | — `fact://2ca7ff48e8fc1f32`
- - Full question set used — `fact://fa22fac04e308268`
- You expand short or vague knowledge-base queries into targeted sub-queries. — `fact://5ea1ab44c0ea697e`
- - A `jekyll_vitepress:` block for branding, syntax highlighting, footer, GitHub star button, etc. — `fact://577d170bb86c3048`
- Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override. — `fact://b4a5a8266d320846`
- Extensions in `TREE_SITTER_TEXT_EXTENSIONS` but not `EXT_MAP` get a **file node only** (`language='text'`, no symbols). — `fact://97c34bf3d94a3fd5`
- | `/docs generate "<prompt>"` | Guided doc-draft wizard | — `fact://3089e87cb7c562bf`
- After scoring, the active pond's frontier is updated from its edge neighbors, pond-lexical hits, and local top scores. — `fact://049113cb24a0859e`
- `kb` exists because maintaining a knowledge base is a pain—and most teams never do it well, or at all. — `fact://61b5efea0de6bf7e`
- Tree-sitter export queries capture `@name` — the identifier node, not the full declaration. — `fact://6e6c6049a4eb9cea`
- flowchart TD A[kb init] --> B[collectSourceFiles] A --> C[crawlSourceCode] B --> B1["Fixed candidates\n(README, CLAUDE, AGENTS, …)"] B --> B2["Top-level *.md files\n(up to 8 total)"] B1 & B2 --> D[sourceFiles\nRecord<path, content>] C --> C1["Walk repo tree\n(skip node_modules, dist, .git, …)"] C1 --> C2["Collect *.ts *.tsx *.js *.py *.go …\n(up to 200 files, 400 chars/file)"] C2 --> E[codeFiles\nRecord<path, snippet>] D & E --> F[InitContext] — `fact://43965baa8e1921b9`
- > KB expects `Node 22+` in the shell that runs `kb`. — `fact://4ee41a969d3f190b`
- Product-wide contracts may live in `src/core/`; implementation detail stays local. — `fact://0eb126cb12440886`
- - Success or follow-up copy in the TUI transcript should use **slash form** (`/base use …`), not `kb …`, so users are not told to leave the chat interface. — `fact://eb994e9f841d8b98`
- In chat mode the InputBar border turns orange and the prompt becomes `you>`. — `fact://3d1c65460570cd9b`
- | `INIT_SOURCE_SHARD_MAX_CHARS` | 8 000 chars | Per-shard content cap | — `fact://9c8f4086be887042`
- When the code graph is indexed, exported symbols are promoted into the `facts` table as human-readable strings like `"Router is a Class exported from src/router.ts"`. — `fact://fa463ea804a04d40`
- **ONLY SEARCH FOR THE BARE MINIMUM BEFORE WORKING** — `fact://45fe5b5d06bee31d`
- Default first install for users: install from GitHub Releases on a fresh machine. — `fact://5e7398f4aafafc34`
- - Grammar load failure per file → falls through to text-node-only (no throw on whole project). — `fact://1c65d9b8dcb73edb`
- 1. Facts are the only “live” knowledge for answering — `fact://33cc07cb71393b76`
- Upstream docs: [jekyll-vitepress.dev](https://jekyll-vitepress.dev/). — `fact://8080935852fe43bd`
- - `EnterPlanModeTool`: Transition to plan mode — `fact://1a7808d095afe67f`
- - **Init progress:** Pass `InitProgressReporter` from TUI; do not append `[init] …` lines to chat history (see `src/tui/TUI.md`). — `fact://6ba3152c701a640a`
- It reads your code and documentation, extracts structured facts, and gives you a fast, queryable knowledge base — so decisions, architecture details, and project context are always at your fingertips. — `fact://241ec05f08aea775`
- VitePress-style theme (`jekyll-vitepress-theme`) — `fact://0b66e7254050397d`
- To set one explicitly: — `fact://374444fd3da86c3d`
- Structural deltas (first→latest, prev→latest) are always shown even without scoring. — `fact://897e1f2c418355a6`
- `cd docs && rbenv local <version> && gem install bundler && bundle install`. — `fact://707ccb2eddcb86cc`
- - **Apply defaults:** TUI `resolveApplyArgs()` auto-appends `--apply` for `publish`, `scan`, and `init --rescan` — CLI users must pass `--apply` explicitly. — `fact://2a08531b0a744a5b`
- **Session override:** Pass `--base <name>` on `kb graph` (same as other KB commands) to target a specific session without switching your active base. — `fact://c9dd3eb76845bb8f`
- | Status bar | `components/StatusBar.tsx` | Base name, mode hints | — `fact://3d8de433dec54879`
- Canonical Question Set — `fact://3a3351e5e2ca5e4e`
- `# Title` → one-paragraph what/why → **Role in the stack** (fit, boundaries, optional mermaid) → **Core pieces** (non-obvious file roles) → **Integration** (callers, deps, config, canonical entrypoints) → **Invariants** (one rule per bullet) → **Extension checklist** → **Gotchas** → **Related docs** (relative links). — `fact://9ea3a37a05e8afd0`
- The TUI passes a capturing implementation so slash commands and init progress do not fight Ink rendering. — `fact://6f87b0b8b82f1f6d`
- <li><a href="{{ doc.url | relative_url }}">{{ doc.title }}</a></li> — `fact://091efd770cab46bf`
- From kb repo root (`pnpm run build` first): — `fact://feca5c8ee7fb3e79`
- `future: true` is also set so collection output is never suppressed for date quirks. — `fact://686e033d27e9593c`
- - `theme: jekyll-vitepress-theme` and `plugins: [jekyll-vitepress-theme]` — `fact://a404aca0fee7b05f`
- The source slice uses the declaration node's spans: — `fact://51fb5fa6841e8010`
- - Agent B maintains and refreshes the knowledge base. — `fact://c8a640748f119b81`
- flowchart TD A[kb init] --> R[read-inputs] R --> MF[document-facts] MF --> CF[code-facts] CF --> FC[fact-categories] FC --> IM[import-docs] IM --> W[write] W --> AF[ast-facts] MF --> MF1["LLM document extraction\n→ facts import_doc"] CF --> CF1["LLM fallback only\n→ import_code facts"] FC --> FC1["User names categories + descriptions\n→ TF-IDF assignment to all facts"] IM --> IM1["One original doc\nper source file"] W --> W1["SQLite upsert\n+ scan planner"] AF --> AF1["AST indexing\n→ facts + fact_edges"] — `fact://2564846483efa429`
- Walk through the chat-based wizard to create your knowledge base. — `fact://86860743c4262ed3`
- `_config.yml` in the docs repo should set `url` and `baseurl` to match that site’s GitHub Pages URL pattern. — `fact://45ff127bba290f23`
- Bundled set — `fact://fc52fb40760738bc`
- When the init pipeline (or any path using **`SqliteDocumentWriter`**) persists markdown documents, the writer **indexes candidate facts** from document bodies (deterministic sentence segmentation, length filters, and capped inserts into the **`facts`** table). — `fact://5e66907ac6e78792`
- - `_data/kb_original_docs.yml` — generated index of original docs (title → URL) — `fact://313b0e94ac2cdd44`
