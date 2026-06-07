`FactsQueryResearchOrchestrator.run()` (src/tools/facts-query-research-orchestrator.ts) stops
collecting evidence through the private `assessSufficiency()` method, which is called after each
iteration. The check is entirely deterministic — no LLM prompt is involved. It filters
`scoredFacts` to entries where `score >= 0.40` and returns `decision: 'answerable'` when at least
10 such facts have been accumulated; otherwise it returns `decision: 'not_answerable_yet'` with
reason `'insufficient-facts'`.

When `assessSufficiency()` returns `'answerable'`, the loop sets `stopReason = 'answerable_plateau'`
and breaks. Three other stop conditions exist: `frontier_exhausted` (all exploration ponds are
marked exhausted and no new facts appear), `weak_evidence_after_exhaustion` (frontier is empty but
fewer than 10 high-scoring facts were found), and `budget_exhausted` (the fact limit or absolute
iteration cap of 512 was reached). The stop reason is recorded in the `retrieval.detail` field of
the `QueryResponse` as `stop:<reason>` alongside pass count, graph hops, and pond count.

Separately, the loop tracks a `plateauCount` via `hasMeaningfulProgress()`. If `plateauCount >= 2`
and the graph/concept frontier cannot be widened further, the loop also stops — this is the
"plateau" branch that sets `stopReason = 'answerable_plateau'` or `'weak_evidence_after_exhaustion'`
depending on the current sufficiency decision. This plateau guard prevents wasted iterations when
each pass adds fewer than 2 new unique facts, less than 0.08 additional concept coverage, and less
than 0.04 improvement in the top-score average.
