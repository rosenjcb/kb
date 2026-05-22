---
layout: default
title: src/core/QUERY_INTERNALS.md
date: '2026-05-22'
kb_id: src-core-query-internals-md
tags:
  - original-source
  - src-core-query-internals-md
  - kb
categories:
  - reference
---

# Query internals: facts retrieval

`kb query` and chat QUERY turns share **`runQueryTruthRetrieval()`** (`src/cli/query-truth-retrieval.ts`): **`runIntentLoop`** → **`DefaultIntentRouter`** → **`read_facts`** (registry in `src/tools/kb-tools-registry.ts`). There is **no** workspace README injection and **no** markdown chunk hybrid pipeline on this path.

## Evidence store

- **`facts` / `facts_fts`** — canonical rows for Q&A (`SqliteKbIndexer.searchFacts`, concept links, optional deterministic semantic scores over fact ids).
- **Documents** — human-facing artifacts (`kb docs`, publish). They are **not** chunked for `read_facts`.

## Shallow vs deep discovery

The router maps the legacy **`read_documents`**-shaped envelope to **`FactsDocumentReader.queryDocuments()`** (`src/tools/facts-document-reader.ts`).

| `discoveryDepth` | Behavior |
|------------------|----------|
| **`shallow`** | Lexical FTS over facts (`searchFacts`), or `listFactsForQuery` when the query string is empty. |
| **`deep`** | **`FactsQueryResearchOrchestrator`** (`src/tools/facts-query-research-orchestrator.ts`): adaptive passes merging lexical hits, concept-frontier / concept rows, deterministic semantic rescoring, category widening, and concept-graph neighbor expansion until the evidence plateaus, the frontier is exhausted, or a safety budget is reached. |

## Answer enrichment

After retrieval, **`enrichReadDocumentsAnswerWithLLM()`** (`src/cli/intent-cli.ts`) turns the final **fact-shaped** hit list into prose. The function name is historical; inputs are **`read_facts`** results (metadata title summarizes fact text; optional body is fact text when `includeContent` is enabled).

## Graph expansion (query string only)

When graph mode is enabled, **`expandQueryWithGraph`** (`src/tools/graph-query-expansion.ts`) may rewrite / widen the **query string** before the intent envelope is built. That expanded string is what **`read_facts`** searches against. See **`src/tools/GRAPH.md`** (“Graph-augmented query”).

## Environment knobs (facts deep loop)

- `KB_FACTS_QUERY_MAX_ITERS` (default `8`, clamped 1–24) — pass budget / safety guardrail
- `KB_FACTS_QUERY_MAX_HOPS` (default `6`, clamped 1–12) — concept neighbor expansion ceiling
- `KB_FACTS_QUERY_MAX_RESULTS` (default `60`, clamped 10–200) — adaptive retrieval-limit ceiling

## Crawl (init-time only)

Unchanged from the previous doc: **`crawlSourceCode()`** during **`kb init`** discovers source snippets for synthesis; it is **not** used at query time. See **`src/core/INIT.md`**.

## See also

- `src/cli/query-truth-retrieval.ts` — shared retrieval entry for CLI query + chat
- `src/tools/facts-document-reader.ts` — shallow path + deep orchestrator dispatch
- `src/tools/facts-query-research-orchestrator.ts` — deep fact retrieval loop
- `src/tools/sqlite-kb-index.ts` — `searchFacts`, concepts, semantic scores
- `src/core/CHAT.md` — chat vs query alignment
- `src/core/AGENT_LOOP.md` — intent loop wiring
