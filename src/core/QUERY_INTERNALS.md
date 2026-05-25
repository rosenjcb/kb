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

1. **Edge neighbors** — `getFactNeighbors(activePond.frontierFactIds, seenIds, edgeBatch)`: one BFS hop from the **active pond's** frontier only (capped per hop so code swamps do not flood a single pass).
2. **Lexical (primary)** — FTS for the original query string.
3. **Lexical (pond)** — FTS for the active pond's sub-query (skipped when identical to primary).
4. **Concept frontier** — facts sharing any concept token in the active concept set.
5. **Concept rows** — facts sharing active concepts (broader union than frontier).

Primary lexical hits from pass 1 are tracked as **anchors** (+0.10 score boost; up to 3 reserved in the final slice). When a pond stalls (no new edge or pond-lexical facts), it is marked exhausted and the loop advances to the next pond. Fresh concept neighbors can spawn an additional pond mid-loop. `frontier_exhausted` fires only when **all ponds** are exhausted and every stream returns nothing new.

After scoring, the active pond's frontier is updated from its edge neighbors, pond-lexical hits, and local top scores. `graphHops` counts global BFS levels across ponds.

## Answer enrichment

After retrieval, **`enrichReadDocumentsAnswerWithLLM()`** (`src/cli/intent-cli.ts`) turns the final **fact-shaped** hit list into prose. The function name is historical; inputs are **`read_facts`** results (metadata title summarizes fact text; optional body is fact text when `includeContent` is enabled).

## Graph expansion (query string only)

When graph mode is enabled, **`expandQueryWithGraph`** (`src/tools/graph-query-expansion.ts`) may rewrite / widen the **query string** before the intent envelope is built. That expanded string is what **`read_facts`** searches against. See **`src/tools/GRAPH.md`** (“Graph-augmented query”).

## Environment knobs (facts deep loop)

- `KB_FACTS_QUERY_MAX_ITERS` (default `24`, clamped 1–24) — pass budget; early-exit conditions
  (`answerable_plateau`, `frontier_exhausted`, `weak_evidence_after_exhaustion`) normally fire
  well before this ceiling. Raised from 8 to 24 so artificial cap never truncates genuine exploration.
- `KB_FACTS_QUERY_MAX_HOPS` (default `20`, clamped 1–40) — concept neighbor expansion ceiling
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
