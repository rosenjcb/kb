# TICKET-012: Benchmark Alignment & Validation Suite

**Status:** Open  
**Priority:** P3  
**Labels:** evaluation, benchmarks, validation

## Context

The MOEL framework is novel, so its results need to be anchored to established industry benchmarks to be credible to external reviewers. Additionally, the `kb`-specific evaluation suite needs a curated task library that exercises the scenarios where `kb` is most expected to help: documentation generation, symbol lookup, cross-file refactoring.

This ticket designs the task library and ensures the MOEL framework's output can be cross-referenced against SWE Atlas, SWE-ContextBench, and CodeScaleBench standards.

## Objective

Build the initial `kb` evaluation task library (minimum 10 tasks) and document the mapping between MOEL metrics and the verification protocols used by each external benchmark.

## Acceptance Criteria

### Task Library
- [ ] At least 10 evaluation tasks covering:
  - Documentation generation (3 tasks): agent must produce accurate markdown docs for a class/module.
  - Symbol lookup & navigation (3 tasks): agent must locate and modify a specific function given only a high-level description.
  - Cross-file refactoring (2 tasks): agent must propagate a signature change across multiple files.
  - Bug diagnosis (2 tasks): agent must identify and fix a seeded logic error.
- [ ] Each task stored as `eval/tasks/<task_id>/`:
  - `task.json` — `TaskDefinition` with rubric, target symbols, test command, budgets.
  - `reference/` — reference output files (`Y*`) for AST loss comparison.
  - `rubric.md` — human-readable rubric with atomic criteria.
  - `optimal_actions.json` — pre-computed optimal action set for trajectory loss.
- [ ] All tasks have working test suites (mutation check is executable).
- [ ] Condition O oracle context is pre-computed and stored in `task.json` for reproducibility.

### Benchmark Alignment Documentation
- [ ] `eval/benchmarks/alignment.md` documents:
  - How `L_correctness` maps to SWE Atlas outcome verification (manifest + mutation checks satisfy their programmatic check requirements).
  - How `L_resource` and trajectory tracking maps to SWE-ContextBench's time efficiency and cache token cost metrics.
  - How the three-condition comparison maps to CodeScaleBench's task validity / outcome validity / tool effectiveness framework.
- [ ] Differences from each benchmark's protocol are explicitly called out (not hidden).

### Reporting
- [ ] `eval/reports/summary.py` produces a comparison table across all tasks and conditions:
  ```
  Task ID | Condition | L_correctness | L_trajectory | L_resource | L_MOEL
  --------|-----------|---------------|--------------|------------|-------
  ```
- [ ] Summary report is exportable as both Markdown and JSON.
- [ ] Includes aggregate statistics: mean L_MOEL per condition, `L_MOEL(N) - L_MOEL(K)` (the primary hypothesis test statistic).

## Implementation Notes

### Task Selection Criteria

Tasks should be drawn from the actual `kb` repository and its dependencies — not synthetic examples. This ensures the evaluation is grounded in real-world `kb` usage patterns and is harder to contaminate via benchmark memorization.

Avoid tasks where the answer is in a well-known public file (e.g., README) — prefer tasks that require navigating internal module relationships.

### Contamination Resistance

Because the tasks are derived from the live `kb` repo, they will change as `kb` evolves. Tag each task with the git commit hash of the repo state it was designed against. The harness should warn if the repo has diverged significantly from the tagged commit.

### Benchmark Alignment Notes

| Benchmark | Key Metric Overlap | Key Gap |
|-----------|-------------------|---------|
| SWE Atlas | Manifest + mutation programmatic checks | SWE Atlas uses static reference text; MOEL uses AST distance |
| SWE-ContextBench | Cache token cost tracking, time efficiency | SWE-ContextBench does not decompose into trajectory vs. resource |
| CodeScaleBench | Three-tier validity (task/outcome/tool) | CodeScaleBench targets multi-repo; MOEL is single-repo focused |

## Output Artifact

`eval/tasks/` — task library  
`eval/benchmarks/alignment.md`  
`eval/reports/summary.py`

## Dependencies

TICKET-010, TICKET-011

## Feeds Into

Final experiment runs and any external publication or peer review of the framework.
