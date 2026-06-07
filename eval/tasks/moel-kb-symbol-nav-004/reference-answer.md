`expandQueryWithGraph()` (src/tools/graph-query-expansion.ts) improves retrieval recall by adding
semantically related terms and code symbols to the query before the main retrieval pass. It operates
in two distinct passes:

**Pass 1 — Code graph expansion (capped at `MAX_CODE_EXPANSION = 8`):** The query is converted to
slug tokens and bigrams by `toGraphQuerySlugs()`, which generates both single-word slugs and two-
word compound slugs (e.g., "api-key", "knowledge-graph") to match compound entity IDs in the graph.
These slugs are used to perform FTS on `facts_fts` filtering to `source_kind='import_code'`, then
a 1-hop traversal of `fact_edges` expands to directly connected code symbols. The result is capped
at `MAX_CODE_EXPANSION` (8) symbol names.

**Pass 2 — Semantic LIKE-scan expansion (capped at `MAX_SEMANTIC_EXPANSION = 18`):** The slug
tokens are used in SQL `LIKE` pattern queries against the `subject` and `object` columns of the
`facts` table. This captures fact entities whose names partially match the query terms. The result
is capped at `MAX_SEMANTIC_EXPANSION` (18) terms.

The expanded terms from both passes are concatenated with the original query and returned as an
augmented query string. Callers include `src/cli/index.ts`, `src/cli/chat-cli.ts`, and
`src/tools/graph-rag-reranker.ts`.
