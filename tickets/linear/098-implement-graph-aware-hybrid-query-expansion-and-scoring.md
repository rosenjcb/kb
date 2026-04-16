# Implement Graph-Aware Hybrid Query Expansion and Scoring

## Ticket ID
098

## Theme
Retrieval quality

## Problem
Graph expansion is currently a narrow pre-retrieval enhancement. Hybrid retrieval still lacks an explicit graph-aware candidate scoring stage.

## Scope
- Add graph-aware score inputs to hybrid retrieval
- Blend graph score into final candidate ranking
- Keep graph effects bounded and explainable

## Acceptance Criteria
- `kb query` and `kb chat` both use graph-aware candidate scoring when enabled
- Retrieval exposes graph score breakdowns for debugging
- Graphless fallback remains safe

## Dependencies
- 097

## Deliverables
- Working code
- Tests
- Updated KB docs

## Estimate
M

## Priority
High

## Status
Closed

## Implementation Notes
- `MarkdownDocumentReader` now performs a bounded graph-aware reranking pass after hybrid candidate collection.
- `DuckGraphWriter` exposes candidate document affinity scoring from query entity slugs.
- Graph boosts are capped and additive so graph evidence can promote strong linked documents without overwhelming lexical/vector relevance.
- `kb query` and `kb chat` continue to respect the graph enable/disable controls from config and `KB_GRAPH`.

## Validation
- `npx vitest run tests/tools/markdown-document-reader.test.ts tests/tools/graph-query-expansion.test.ts tests/cli/config-cli.test.ts`
- `npm run type-check`
- `npm run build`
