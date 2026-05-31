---
layout: default
title: src/core/QUERY_INTERNALS.md
date: '2026-05-30'
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
| **`deep`** | **`FactsQueryResearchOrchestrator`** (`src/tools/facts-query-research-orchestrator.ts`): adaptive passes merging **BFS edge-walk neighbors** (`fact_edges`), lexical hits, concept-frontier rows, and deterministic semantic rescoring until the evidence plateaus, the frontier is exhausted, or a safety budget is reached. |

## Deep loop — per-iteration sources

Each pass round-robins an **exploration pond** — a sub-query with its own BFS frontier — so one code-heavy neighborhood cannot monopolize the walk.

Pond seeds come from `buildPondQueries`: the full query, token pairs (`languages supported`, `init scan`, …), and single-token fallbacks. Each pond gets a diverse lexical seed (mixed `source_kind`) before the loop starts.

Each pass merges five candidate streams before dedup and scoring:

1. **Edge neighbors** — `getFactNeighbors(activePond.frontierFactIds, seenIds, perIterationLimit)`: one BFS hop from the **active pond's** frontier only.
2. **Lexical (primary)** — FTS for the original query string.
3. **Lexical (pond)** — FTS for the active pond's sub-query (skipped when identical to primary).
4. **Concept frontier** — facts sharing any concept token in the active concept set.
5. **Concept rows** — facts sharing active concepts (broader union than frontier).

Primary lexical hits from pass 1 are tracked as **anchors** (+0.10 score boost; up to 3 reserved in the final slice). When a pond stalls (no new edge or pond-lexical facts), it is marked exhausted and the loop advances to the next pond. Fresh concept neighbors can spawn an additional pond mid-loop. `frontier_exhausted` fires only when **all ponds** are exhausted and every stream returns nothing new.

After scoring, the active pond's frontier is updated from its edge neighbors, pond-lexical hits, and local top scores. `graphHops` counts global BFS levels across ponds.

## Answer enrichment

After retrieval, **`enrichReadDocumentsAnswerWithLLM()`** (`src/cli/intent-cli.ts`) and chat synthesis (`src/cli/chat-cli.ts`) turn the final **fact-shaped** hit list into prose. Both paths pass the **entire ranked retrieval pool** to the LLM via **`formatRetrievedFactsForLLM()`** (`src/core/retrieval-context.ts`) — full `fact_text`, no snippet extraction or char caps.

Terminal **`evidence>`** is a **single summary header** (`formatEvidenceSummaryHeader()` in `src/core/evidence-summary.ts`) — count, doc/code mix, top themes, lead titles, walk/stop/conf. No per-fact bullet lines. See **`src/core/EVIDENCE_SUMMARY.md`**.

## Fact collection budget

**One limit controls how many facts are collected: `DEFAULT_FACT_LIMIT`** (`src/tools/facts-query-research-orchestrator.ts`, default `500`). The loop checks `scoredFacts.size >= input.limit` at the top of each iteration and breaks when reached. `DEFAULT_FACT_LIMIT` is also the starting per-iteration DB fetch count (`perIterationLimit = 50` per call) and the value the router passes as `input.limit`.

There is **no output trimming** — all scored facts in `scoredFacts` are passed to the LLM via `buildResponse`. Recall-first: answer quality over token economy.

| Layer | What it limits | Default |
|-------|----------------|---------|
| **Total facts collected** | `scoredFacts.size` cap | `DEFAULT_FACT_LIMIT` = 500 |
| **Per DB call** | Rows from each `searchFacts` / `getFactNeighbors` call | `perIterationLimit` = 50 (fixed) |
| **Loop passes** | Round-robin pond iterations | 24 (`KB_FACTS_QUERY_MAX_ITERS`) |
| **Graph hops** | BFS levels across all ponds | 20 (`KB_FACTS_QUERY_MAX_HOPS`) |

## Graph expansion (query string only)

When graph mode is enabled, **`expandQueryWithGraph`** (`src/tools/graph-query-expansion.ts`) may rewrite / widen the **query string** before the intent envelope is built. That expanded string is what **`read_facts`** searches against. See **`src/tools/GRAPH.md`** (“Graph-augmented query”).

## Sufficiency and early exit

Each iteration calls `assessSufficiency()`. The loop exits immediately (no plateau wait) when ≥10 facts score ≥0.40 against the query. If that threshold is never reached the loop continues until the frontier is exhausted, a plateau is detected (2 iterations with no meaningful gain), or the fact budget is hit.

## Environment knobs (facts deep loop)

- `KB_FACTS_QUERY_MAX_ITERS` (default `24`, clamped 1–24; `-1` = unlimited up to 512 passes)
- `KB_FACTS_QUERY_MAX_HOPS` (default `20`, clamped 1–40; `-1` = unlimited)
- `KB_FACTS_QUERY_MAX_PONDS` (default `6`, clamped 2–12; `-1` = unlimited up to 32 ponds)

Use `-1` only for debugging — absolute safety caps still apply on iters/ponds.

## Crawl (init-time only)

Code facts at query time come from the AST-indexed `facts` table (`source_kind='import_code'`). See **`src/core/INIT.md`** for ingest coverage.

## See also

- `src/cli/query-truth-retrieval.ts` — shared retrieval entry for CLI query + chat
- `src/tools/facts-document-reader.ts` — shallow path + deep orchestrator dispatch
- `src/tools/facts-query-research-orchestrator.ts` — deep fact retrieval loop
- `src/tools/sqlite-kb-index.ts` — `searchFacts`, concepts, semantic scores
- `src/core/CHAT.md` — chat vs query alignment
- `src/core/AGENT_LOOP.md` — intent loop wiring
