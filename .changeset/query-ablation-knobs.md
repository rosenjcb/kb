---
"kb": minor
---

Add env-gated ablation knobs to the query retrieval path for hypothesis-driven diagnosis
of "how does X work" retrieval failures. All default off (no behavior change):
`KB_ABLATE_NO_EXPANSION` (skip graph query expansion), `KB_ABLATE_JUDGE_CAP` (override the
curator candidate cap), `KB_ABLATE_RAW_SCORING` + `KB_ABLATE_RAW_Q` (score overlap/semantic
against the raw question while discovery stays expanded), and `KB_ABLATE_CURATOR_RAW_Q`
(feed the curator the raw question instead of the graph-expanded string).
