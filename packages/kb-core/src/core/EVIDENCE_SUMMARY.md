---
type: "Feature"
title: "Evidence Summary Header"
description: "The single evidence> orchestration line printed after a terminal query or chat answer."
resource: ./src/core/evidence-summary.ts
tags: [evidence, cli-output, retrieval]
timestamp: 2026-06-20T00:00:00Z
---

# Evidence summary header (`evidence>`)

Terminal query/chat output prints **one** `evidence>` orchestration line after the answer. It replaces per-fact bullet previews.

Implementation: **`formatEvidenceSummaryHeader()`** in `src/core/evidence-summary.ts`, wired from `printEvidenceSummaryBlock()` / `formatReadDocumentsHumanResult()` in `src/cli/intent-cli.ts`.

## Purpose

Humans need a scannable read on **what retrieval produced** without duplicating fact bodies the LLM already consumed. The LLM still receives the ranked pool via `formatRetrievedFactsForLLM()` — this header is display-only.

## Segment order

Segments join with ` · ` (middle dot):

| Segment | Source | Example |
|---------|--------|---------|
| **Count → LLM** | `results.length` | `200 facts → LLM (full text)` |
| **Mix** | `metadata.tags[0]` source_kind tallies | `mix: 142 doc · 58 code` or `mix: all doc` |
| **Repos** | `git_repo` origin tallies across the pool (top 4 by frequency) | `repos: auth-svc, web, shared` |
| **Leads** | top 3 unique `metadata.title` values (rank order) | `leads: Language \| Extensions, TsMorphIndexer, …` |
| **Walk** | parsed from `retrieval.detail` | `walk: 24p/20h/6 ponds` |
| **Stop** | `stop:` token in `retrieval.detail` | `stop: budget_exhausted` |
| **Evidence** | last checkpoint `evidence` label | `evidence: moderate` |

Optional segments omitted when data missing.

## Example

```
evidence> 200 facts → LLM (full text) · mix: 120 doc · 80 code · repos: auth-svc, web, shared · leads: Language | Extensions | Code-graph (AST), TsMorphIndexer, Tree-Sitter Code Graph Indexer · walk: 24p/20h/6 ponds · stop: budget_exhausted · conf: 0.68
```

## Related footer lines

| Line | Role |
|------|------|
| `retrieval>` | method + full loop detail string |
| `matches>` | `{N} ranked facts` (count only) |
| `sources>` | top 10 fact URIs by rank (`top N of M ranked: …`; all when M ≤ 10) |

## Tests

`tests/core/evidence-summary.test.ts` — mix/repos/leads parsing, walk/stop/conf from retrieval detail, dedupe rules.

## See also

- `src/core/QUERY_INTERNALS.md` — BFS loop and limits
- `src/core/retrieval-context.ts` — LLM fact payloads
