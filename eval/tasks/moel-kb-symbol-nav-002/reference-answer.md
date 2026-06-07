`retrieval-lane-router.ts` (src/tools/retrieval-lane-router.ts) is responsible for classifying
both queries and documents into semantic lane categories that determine retrieval strategy. It
defines `RetrievalLane` as a string union of six values: `error-runbook`, `fact`, `policy`,
`architecture`, `session-log`, and `workflow`. Each lane corresponds to a category of knowledge
that kb stores and retrieves distinctly.

Three exported functions form the public API: `routeQueryToLanes(query)` takes a query string and
returns a `LaneRoutingDecision` containing `lanes` (primary), `fallbackLanes`, `lastResortLanes`,
and `reason` — the routing decision is deterministic based on keyword heuristics.
`classifyDocumentLane(content)` takes document text and assigns it to a single `RetrievalLane`.
`laneFitnessBoost(laneIndex)` provides post-retrieval reranking weights: 0.15 for the highest-
priority matching lane (index 0), 0.10 for index 1, 0.05 for index 2, and 0.02 for index 3+.

Lane fitness is applied after retrieval as a scoring bonus, not as a pre-filter. This means all
facts are retrieved from the database first, then lane-matched facts receive additive score boosts.
Lane routing is distinct from FTS or semantic vector scoring — it is a fast keyword-based
classification used to bias reranking rather than replace retrieval.
