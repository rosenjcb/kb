# Graph-Aware Ranking for Hybrid Retrieval

## Ticket ID
097

## Theme
Retrieval quality

## Problem
The current graph hook improves a narrow class of bridge queries, but it does not yet produce a consistent win across broader question sets. Right now graph support mainly works by appending neighbor names onto the raw query string for `kb query` and `kb chat`. That proves the graph can help recall, but it leaves hybrid ranking blind to graph structure after the expansion step.

## Scope
- Define how graph signals should influence hybrid retrieval beyond raw text expansion
- Decide where graph-aware scoring belongs in the current retrieval pipeline
- Define evaluation criteria, observability, and rollout controls
- Split implementation into explicit follow-up tickets

## Acceptance Criteria
- A concrete implementation plan exists for graph-aware ranking in hybrid retrieval
- The plan explains how graph signals interact with lexical and vector-style ranking
- The plan defines rollout controls and evaluation strategy
- Follow-up implementation tickets exist before this spike is closed

## Dependencies
- Existing hybrid retrieval pipeline in `src/tools/markdown-document-reader.ts`
- Existing graph store and query expansion work in `src/tools/duck-graph-writer.ts` and `src/tools/graph-query-expansion.ts`
- Existing graph toggle via `graph.enabled` / `KB_GRAPH`

## Deliverables
- Closed spike ticket with implementation plan
- Follow-up implementation tickets

## Estimate
SPIKE

## Priority
High

---

## Implementation Plan

### Graph Signals Should Re-Rank Hybrid Candidates, Not Just Expand Query Text

#### Background
The recent graph experiment showed a real but narrow benefit: graph expansion improves bridge-style recall, but it does not consistently beat the current lexical/hybrid stack on broader questions. That suggests the next leverage point is candidate scoring, not just pre-retrieval query rewriting.

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
  - Define graph-aware ranking design
  - Define rollout and observability
  - Create explicit follow-up tickets
- ⏳ Phase 2 (Implementation): Deferred
  - Graph-aware hybrid scoring changes
  - Benchmarks and score breakdowns
  - Rollout tuning based on measured retrieval results

#### Approach
Keep graph mode enabled by default, but evolve the retrieval pipeline so graph data contributes an explicit scoring component on top of existing lexical and vector-style candidate ranking. The graph should not directly replace lexical or vector evidence; instead it should provide a bounded bonus when the query terms are connected to candidate document entities through high-confidence graph relationships. The retrieval system should first gather candidates the normal way, then compute a graph affinity score for each candidate, and finally blend that score into the hybrid rank with conservative weights. This keeps graph influence explainable, debuggable, and easy to disable when it hurts quality.

#### Examples / Specifications

Proposed retrieval flow:

```text
query
  -> lexical / FTS candidates
  -> vector-style / hybrid candidates
  -> graph neighbor lookup for query concepts
  -> candidate graph affinity scoring
  -> blended final score
  -> ranked results + score breakdown
```

Candidate scoring sketch:

```ts
type CandidateScoreBreakdown = {
  lexicalScore: number
  semanticScore: number
  graphScore: number
  finalScore: number
  graphEvidence: string[]
}

finalScore =
  (lexicalScore * lexicalWeight) +
  (semanticScore * semanticWeight) +
  (graphScore * graphWeight)
```

Proposed graph affinity inputs:

```ts
type GraphAffinityInput = {
  queryEntitySlugs: string[]
  candidateDocumentId: string
  candidateEntityIds: string[]
}
```

Proposed graph bonus rules:

- direct entity match between query and candidate doc entity → strongest bonus
- one-hop neighbor match → moderate bonus
- repeated weak neighbors cap out at a low ceiling
- no graph evidence → zero bonus
- graph-only candidates should not outrank strong lexical evidence by default

Suggested rollout controls:

```json
{
  "graph": {
    "enabled": true,
    "rankingEnabled": true,
    "rankingWeight": 0.12,
    "rankingMaxBoost": 0.2
  }
}
```

Env overrides:

```bash
KB_GRAPH=false
KB_GRAPH_RANKING=false
KB_GRAPH_RANKING_WEIGHT=0.12
```

#### Error Conditions / Edge Cases
- If the graph DB is missing or unreadable, retrieval falls back to the existing non-graph hybrid ranking
- If a query produces no graph entities, graph scoring contributes `0`
- If graph edges are noisy or overly broad, the max graph boost must cap ranking distortion
- If graph-only evidence disagrees with lexical evidence, lexical/vector signals remain primary until measured results justify stronger graph weighting
- If score breakdowns are unavailable, user-facing retrieval still succeeds without graph observability fields

#### Decisions Made
- ✅ Decided: Graph-aware ranking should happen **after candidate generation** → Rationale: it avoids making graph expansion the only mechanism and lets us score graph evidence against already-plausible candidates
- ✅ Decided: Graph contributes a **bounded bonus**, not a replacement score → Rationale: this keeps the system robust when graph extraction is incomplete or noisy
- ✅ Decided: `kb query` and `kb chat` should share the same graph-aware retrieval primitives → Rationale: one retrieval model is easier to reason about and benchmark
- ✅ Decided: Rollout should be controlled by config/env gates → Rationale: we already introduced graph enablement controls and can extend them safely
- ✅ Decided: This ticket is planning-only and implementation is deferred to explicit follow-ups → Rationale: the design is now clear enough to split into focused execution slices

#### Integration Points
- `src/tools/markdown-document-reader.ts` should own graph-aware candidate scoring because it already owns hybrid retrieval and fallback logic
- `src/tools/duck-graph-writer.ts` should expose the minimal APIs needed to map query entities and candidate docs into graph affinity signals
- `src/tools/graph-query-expansion.ts` should remain as the pre-retrieval helper, but ranking should no longer depend on expansion alone
- `kb query` and `kb chat` should use the same graph-aware retrieval behavior once hybrid scoring is centralized

#### Follow-up Tickets
- `098` — implement graph-aware hybrid query expansion and candidate scoring
- `099` — add graph-aware retrieval benchmarks, score breakdown logging, and tuning thresholds

#### Validation & Closure
This implementation plan establishes:
- ✅ A concrete design for graph-aware ranking in hybrid retrieval
- ✅ A bounded rollout strategy with config/env controls
- ✅ Explicit follow-up implementation tickets for code and measurement work

**Ticket 097 is now closed.**
