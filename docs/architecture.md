---
layout: default
title: Architecture
---

# Architecture

KB is a TypeScript/Node.js CLI tool. The codebase is split into three layers — `core`, `tools`, and `cli` — with a TUI layer on top.

---

## Project map

```
src/
  core/    — provider abstraction, intent loop, agent loop, types
  cli/     — CLI entrypoint, command parsing, kb init, chat, config
  tools/   — document writer/reader, SQLite index, graph, task tool
  tui/     — Ink-based interactive shell
```

---

## Core layer (`src/core/`)

### Intent loop

Every intent command (`query`, `submit`, `validate`, `dispute`, `explain`) runs through `runIntentLoop` in `src/core/intent-loop.ts`.

The loop wraps `DefaultIntentRouter.execute()` with:

- **Discovery escalation** — if a query returns zero or too-few results, the loop re-runs with `discoveryDepth: 'deep'` and a doubled result limit.
- **LLM validation reasoning** — if `validate` returns confidence ~0.45 (docs found but inconclusive), a second LLM pass runs to determine SUPPORTED / NOT_SUPPORTED / UNCERTAIN.
- **No retry for mutations** — `submit` and `dispute` are single-pass because retrying mutations risks idempotency issues.

### Agent loop

`agentLoop` in `src/core/agent-loop.ts` is a low-level `AsyncGenerator<AgentEvent>` for autonomous LLM tool-calling. The LLM decides which tools to call and for how many turns. It is **not used by the CLI** — it's available for SDK consumers and the subagent orchestrator.

### LLM provider abstraction

`LLMProvider` is a simple interface with a single `call(params): Promise<LLMResponse>` method. Any provider (Anthropic, OpenAI, mock) can be swapped in by implementing this interface.

---

## Tools layer (`src/tools/`)

### SQLite document index

`SqliteKbIndexer` in `src/tools/sqlite-kb-index.ts` stores documents with full-text search. Queries use BM25 ranking by default; when `better-sqlite3` native bindings are available, a hybrid FTS + vector-style reranking pass improves result quality.

### Knowledge graph

`DuckGraphWriter` in `src/tools/duck-graph-writer.ts` maintains a property graph in DuckDB. Entities and relationships are extracted from document text by an LLM call (`graph-entity-extractor.ts`) and upserted after every `submit` and after `kb init`. See [Knowledge Graph](knowledge-graph) for details.

### Document tools

Tool operations follow a single-responsibility convention: `write_document`, `update_document`, `append_to_document`, `merge_documents`, `read_document`, `query_documents`, etc. Each tool has one purpose — no polymorphic `operationMode` parameters.

### Task tool (subagent orchestrator)

`src/tools/task.ts` implements a `task` tool that delegates work to a nested `agentLoop` running with a filtered subset of the parent registry's tools. The subagent cannot call `task` recursively. Worker profiles (default, research) live in `src/core/agents/agent-registry.ts`.

---

## CLI layer (`src/cli/`)

### `kb init` cycle loop

`init-cli.ts` implements a 7-cycle deterministic pipeline with checkpoint/resume support:

| Cycle | What happens |
|---|---|
| `read-inputs` | Discover source files, run user interview |
| `pass1` | LLM drafts 5–15 candidate documents (temp 0.2) |
| `pass2` | Coverage gap analysis + LLM refinement (temp 0.1) |
| `pass-enrich` | Per-document LLM enrichment pass, parallel (temp 0.15) |
| `pass-consolidate` | Overlap merging — currently disabled |
| `pass3` | Final quality validation (temp 0.0) |
| `write` | Upsert documents to SQLite |

Each cycle writes a checkpoint to `~/.kb/<base>/checkpoints/init-latest.checkpoint.json`. Use `--resume` to continue from the last checkpoint after an interruption.

### `kb chat` tiered retrieval

`chat-cli.ts` uses a deterministic recovery stack on each turn:

```
read_documents (shallow)
  → if confidence < 0.45: recovery query (simplified tokens)
  → LLM completion (temp 0.15, maxTokens 4096)
  → if answer looks insufficient: deep discovery (3× limit)
  → if still insufficient: focused evidence query (keyword rewrite)
  → if still insufficient: surface "not enough evidence" message
```

No `agentLoop` — the retrieval stack is fully deterministic.

---

## Prompts

LLM prompts are stored as plain Markdown in `src/prompts/` rather than inline strings in TypeScript. Two formats:

**Single-part** — the whole file is the prompt.

**Two-part** — file is split by a `---` divider into `intro` (role/context) and `instructions` (task rules), loaded via `loadPromptParts()` and passed to `buildBudgetedPrompt`.

This makes prompts easy to find, read, and edit without touching TypeScript.

| File | Used by |
|---|---|
| `chat-system.md` | `kb chat` LLM system prompt |
| `graph-extraction.md` | Knowledge graph entity extractor |
| `fact-checker.md` | `kb validate` LLM reasoning pass |
| `init-synthesis.md` | `kb init` pass1 |
| `init-refinement.md` | `kb init` pass2 |
| `init-quality.md` | `kb init` pass3 |
| `init-enrichment.md` | `kb init` pass-enrich |

---

## Data flow

```
kb query "topic"
    │
    ▼
runIntentLoop
    │
    ├─ DefaultIntentRouter.execute()
    │       │
    │       ├─ graph expansion (DuckDB — neighbors of query terms)
    │       └─ SQLite hybrid retrieval (BM25 + rerank)
    │
    ├─ weak result? → escalate depth, retry
    │
    └─ enrichReadDocumentsAnswerWithLLM()
            │
            └─ LLM synthesizes prose answer from retrieved docs
```

---

## Build

```bash
npm run build        # tsc + esbuild bundle → dist/bin/kb.js
npm run dev          # tsx src/cli/index.ts (no compile step)
npm run test         # vitest
npm run lint         # biome
```

The `kb` binary is a single esbuild bundle. Prompt `.md` files are copied alongside it into `dist/bin/` at build time.
