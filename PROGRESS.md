# KB Progress

## Eval benchmark: kb vs control (2026-06-12, run `kb-2026-06-11-1920`)

The eval suite runs 8 questions against two conditions side-by-side: **KB** (kb query over a
live knowledge base) and **Control** (Claude Code headless, no KB, reads raw files). Both are
auto-scored 0–4 on four axes by a Gemini judge using the same rubric.

### Aggregate scores

| Axis | KB | Control | Δ (kb − ctrl) |
|---|---|---|---|
| Correctness | 2.75 | 3.88 | **−1.13** |
| Usefulness | 3.63 | 4.00 | −0.38 |
| Specificity | 3.38 | 4.00 | −0.63 |
| Evidence handling | 3.00 | 4.00 | **−1.00** |
| Pass rate (corr≥3 & use≥3) | 0.625 | 1.000 | **−0.375** |

Control ran 8 questions at ~8.75 turns/question, cost **$1.54** total (~9 min).
KB queries cost ~$0 (retrieval only).

### Per-question breakdown

| Q | Topic | KB corr | Ctrl corr | Gap |
|---|---|---|---|---|
| 1 | What is kb + main commands | 2 | 3 | −1 |
| 2 | kb init indexing phases + SQLite | 3 | 4 | −1 |
| 3 | kb scan vs kb init | 3 | 4 | −1 |
| 4 | Retrieval / hybrid search / facts-first | 3 | 4 | −1 |
| 5 | Skills system — define, bundle, install | 3 | 4 | −1 |
| 6 | AST indexers, languages, interaction | **4** | **4** | 0 |
| 7 | Query-expansion internals + callers | 2 | 4 | **−2** |
| 8 | Eval system — eval-run.mjs, scoring | 2 | 4 | **−2** |

Q6 (AST indexers) is the only question where KB ties control. The worst gaps are Q7
(query-expansion) and Q8 (eval system) — both deep code-internal topics with lots of
cross-file logic that the current fact set under-represents.

---

## Current KB limitations

### 1. Weak fact discovery on deep code-internal questions

KB ties or beats control on well-documented surface-level commands (Q6). It falls behind
on questions about internal mechanisms (query expansion, scoring formulas, eval pipeline)
where the answer requires tracing call chains across many files. The indexer surfaces facts
but misses multi-hop relationships that a raw file scan naturally traverses.

### 2. Missing key details in stored facts

Judge notes flag specific gaps on every question:
- Q1: misses `kb submit`, agent skills, local-first/SQLite/hybrid framing
- Q2: misses `read-inputs` cycle and several SQLite tables (`facts_fts`, `graph_edges`)
- Q3: misses the "skip cache-invalidation" detail that distinguishes `kb scan`
- Q4: misses the specific scoring formula (`lexical rank + semantic×0.35 + lane fitness boost`)
- Q7: misses multi-stage expansion mechanism (code-graph traversal, token-budget logic)
- Q8: misses `scripts/eval-run.mjs` path, suite YAML structure, control phase, artifact format

These are not retrieval failures — the facts either aren't indexed or the indexer doesn't
extract them from the source at the right granularity.

### 3. Evidence handling (score 3.0 vs control 4.0)

KB answers reference retrieved facts but don't always acknowledge gaps or distinguish
high-confidence from low-confidence retrieval. Control answers explicitly cite files and
flag when they couldn't find something. The KB answer format doesn't naturally surface
retrieval confidence back to the user.

### 4. Query expansion doesn't fully compensate for fact gaps

The query-expansion module fires but when the underlying facts are thin, expanding the
query surfaces adjacent facts rather than the missing ones. Expansion is a recall
amplifier, not a coverage substitute.

---

## What's working

- **Retrieval mechanics are sound.** When facts exist, KB retrieves them correctly (Q4, Q6).
- **Usefulness is high** (3.63 avg) — KB answers are generally actionable even when incomplete.
- **Zero marginal cost.** KB queries are essentially free vs $1.54/run for control.
- **Control baseline is now running correctly.** The `--bare` flag bug (broke auth, all 8
  agents exited 1) was fixed; `--strict-mcp-config` alone blocks KB/MCP tools.

---

## Next areas to improve

1. **Richer fact extraction** — specifically for internal-mechanism questions: scoring
   formulas, call-graph paths, multi-file flows. Likely needs deeper AST traversal or
   explicit "mechanism" fact type.
2. **Cross-file relationship indexing** — Q7/Q8 failures suggest the graph edges don't
   capture enough caller→callee links for deep internal modules.
3. **Evidence handling in answers** — surface retrieval confidence scores to users;
   acknowledge when relevant facts were not found.
