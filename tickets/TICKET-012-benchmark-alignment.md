# TICKET-012: Benchmark Tasks & Alignment Suite

**Status:** Open  
**Priority:** P3  
**Language:** TypeScript + YAML  
**Labels:** evaluation, benchmarks, tasks

## Context

The MOEL framework needs a curated task library that exercises scenarios where `kb` is most expected to help: fact retrieval, symbol navigation, cross-file reasoning, and documentation quality. Tasks are defined as YAML files extending the existing `eval/suites/*.yaml` format used by `eval-run.mjs`.

Results also need to be anchored to established benchmarks (SWE Atlas, SWE-ContextBench, CodeScaleBench) to be credible to external reviewers.

## Objective

Build the initial task library (minimum 10 tasks) in the existing YAML format with MOEL-specific extensions, and document how MOEL metrics map to external benchmark verification protocols.

## Task YAML Format Extension

The existing `eval/suites/kb.yaml` format has: `questions[]` with `question` and `answer`. MOEL tasks extend this with additional required fields:

```yaml
# eval/suites/moel-kb.yaml
rubricContext: "Evaluate against the kb codebase"
tasks:
  - id: kb-fact-retrieval-001
    question: "How does kb's retrieval orchestrator detect when it has gathered sufficient evidence?"
    answer: "<reference answer>"
    targetSymbols:
      - "FactsQueryResearchOrchestrator"
      - "detectPlateau"
    rubric:
      - "Does the answer correctly identify plateau detection as the stopping criterion?"
      - "Does the answer mention the sufficiency check mechanism?"
      - "Is the answer free of hallucinated function names?"
    tokenBudget: 150000
    stepCeiling: 15
    oracleFactIds: []    # populated by moel-run.mjs at runtime via SQLite query
```

## Acceptance Criteria

### Task Library (minimum 10 tasks across 4 categories)

**Fact Retrieval (3 tasks)** — agent must answer a question about kb's internal architecture using only what it can retrieve from the fact store.
- [ ] How does the retrieval orchestrator detect evidence sufficiency?
- [ ] What is the relationship between `fact_edges` and `get_code_neighbors`?
- [ ] How does kb handle incremental rescans when files change?

**Symbol Navigation (3 tasks)** — agent must locate a specific symbol in the codebase and describe its behavior.
- [ ] What does `TreeSitterIndexer` extract from non-TypeScript files?
- [ ] What is the role of `retrieval-lane-router.ts`?
- [ ] How does `TokenCountingProvider` integrate with the stage telemetry system?

**Cross-File Reasoning (2 tasks)** — agent must connect information across multiple files/facts.
- [ ] How do `eval-run.mjs` and `kb-config.ts` coordinate LLM provider selection?
- [ ] What is the data flow from `kb init` to a fact appearing in `read_facts` results?

**Documentation Quality (2 tasks)** — agent must produce a documentation artifact (markdown) that accurately describes a class or module.
- [ ] Write a one-paragraph description of the `RunCollector` class including its lifecycle and output.
- [ ] Write a one-paragraph description of how `fact_categories` are assigned during init.

### Task Artifacts
- [ ] Each task in `eval/suites/moel-kb.yaml` with all required YAML fields.
- [ ] `eval/tasks/<taskId>/reference-answer.md` — expert-written reference for AST and jury comparison.
- [ ] `eval/tasks/<taskId>/optimal-actions-K.json` — pre-computed optimal kb tool call set for Condition K.
- [ ] `eval/tasks/<taskId>/optimal-actions-N.json` — pre-computed optimal file read set for Condition N.

### Benchmark Alignment Documentation
- [ ] `eval/benchmarks/alignment.md` covering:
  - SWE Atlas: how manifest + mutation checks satisfy their programmatic check requirements; where MOEL differs (AST distance vs. static reference text matching).
  - SWE-ContextBench: how `L_resource` and trajectory tracking maps to their time-efficiency and cache-token-cost metrics.
  - CodeScaleBench: how the three-condition comparison maps to their task/outcome/tool validity tiers. Differences called out explicitly.

### Summary Reporter
- [ ] `eval/reports/summary.ts` produces a Markdown and JSON comparison table:
  ```
  Task ID                | N L_MOEL | K L_MOEL | O L_MOEL | N-K Delta | Hypothesis
  -----------------------|----------|----------|----------|-----------|----------
  kb-fact-retrieval-001  |  0.72    |  0.31    |  0.18    |  +0.41    | ✓
  ```
- [ ] Aggregate row: mean `L_MOEL` per condition, overall `N - K` delta.

## Implementation Notes

### Task Selection Rationale

All tasks are drawn from the kb repo itself (dogfooding). This prevents benchmark contamination — no external repo that a model might have memorized. Tasks are tagged with the git commit hash they were designed against; the harness warns if the repo has diverged.

### Pre-Computing Optimal Actions

For Condition K optimal actions, run a query against the kb SQLite database (assuming `kb init` has been run on the repo) and record the fact IDs returned by a BFS from the target symbols. Store as `optimal-actions-K.json`.

For Condition N, record the file paths returned by `git grep -l <symbol>` for each target symbol. Store as `optimal-actions-N.json`.

These are pre-computed once and committed — the harness reads them rather than recomputing at evaluation time.

## Files to Create

- `eval/suites/moel-kb.yaml`
- `eval/tasks/<taskId>/` (10+ task directories)
- `eval/benchmarks/alignment.md`
- `eval/reports/summary.ts`

## Dependencies

TICKET-010, TICKET-011

## Feeds Into

Final experiment runs and external publication.
