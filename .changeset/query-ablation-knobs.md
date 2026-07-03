---
"kb": minor
---

Real embeddings for semantic fact scoring, plus env-gated retrieval ablation knobs.

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
