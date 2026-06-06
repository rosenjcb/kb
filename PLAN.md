# MOEL Evaluation Framework — Project Plan

## What We're Building

This project implements a **Multi-Objective Exploration Loss (MOEL)** evaluation framework to rigorously measure whether `kb`'s structured codebase indexing makes developer agents more efficient.

The core claim we want to prove: agents equipped with `kb`'s semantic index produce functionally equivalent code using fewer steps and fewer tokens than agents navigating a raw filesystem. Proving this requires moving beyond "did the tests pass?" to a framework that captures *how* the agent got there.

## The Problem

Current evaluation approaches have two failure modes:

1. **Outcome-only measurement** — pass/fail test results ignore the cost of exploration. An agent that reads 40 files before making a 3-line change and an agent that reads 2 files are indistinguishable under a binary pass/fail signal.

2. **LLM-as-judge bias** — judges rubber-stamp incorrect code, with True Negative Rates below 25%. Qualitative scoring without structural grounding is not a reliable signal.

MOEL addresses both by combining three normalized loss terms into a single weighted objective:

```
L_MOEL = w_c · L_correctness + w_t · L_trajectory + w_r · L_resource
```

where `w_c + w_t + w_r = 1`.

## How the Tickets Solve It

The tickets below decompose the framework into independently deliverable components, ordered roughly by dependency. Each ticket produces a concrete artifact (a module, a harness, a calibration dataset) that feeds into the final evaluation pipeline.

```
Telemetry (001)
    │
    ├─► AST Loss (002) ──────────────┐
    │                                │
    ├─► LLM Jury Loss (003) ─────────┼─► MOEL Aggregator (006)
    │                                │         │
    ├─► Trajectory Loss (004) ───────┤         │
    │                                │         ▼
    └─► Resource Loss (005) ─────────┘   Evaluation Harness (010)
                                               │
    Bias Mitigation (007) ──────────────► Calibration (008)
    Manifest & Mutation Checks (009) ──►       │
    Context Compaction (011) ──────────►       │
    Benchmark Alignment (012) ─────────────────┘
```

### Ticket Index

| Ticket | Title | Depends On |
|--------|-------|------------|
| [001](tickets/TICKET-001-telemetry-instrumentation.md) | Telemetry & Trajectory Instrumentation | — |
| [002](tickets/TICKET-002-ast-structural-loss.md) | AST Structural Loss (`L_AST`) | 001 |
| [003](tickets/TICKET-003-llm-jury-semantic-loss.md) | LLM Jury Semantic Loss (`L_jury`) | 001 |
| [004](tickets/TICKET-004-trajectory-inefficiency-loss.md) | Trajectory Inefficiency Loss (`L_trajectory`) | 001 |
| [005](tickets/TICKET-005-resource-consumption-loss.md) | Resource Consumption Loss (`L_resource`) | 001 |
| [006](tickets/TICKET-006-moel-aggregator.md) | MOEL Aggregator | 002, 003, 004, 005 |
| [007](tickets/TICKET-007-bias-mitigation.md) | LLM Judge Bias Mitigation | 003 |
| [008](tickets/TICKET-008-statistical-calibration.md) | Statistical Calibration Framework | 007 |
| [009](tickets/TICKET-009-manifest-mutation-checks.md) | Programmatic Validation (Manifest & Mutation) | 001 |
| [010](tickets/TICKET-010-evaluation-harness.md) | Evaluation Harness & Condition Environments | 006, 009 |
| [011](tickets/TICKET-011-context-compaction.md) | Context Compaction & Runaway Limits | 010 |
| [012](tickets/TICKET-012-benchmark-alignment.md) | Benchmark Alignment & Validation Suite | 010, 011 |

## Three Evaluation Conditions

Every task is run under three controlled conditions to isolate the contribution of `kb`:

- **Condition N (Baseline FS):** Raw filesystem, agent uses grep/find/file reads. This is the worst-case exploration baseline.
- **Condition K (kb-Enabled):** Agent has access to `kb`'s semantic index and structured query tools. This is the primary experimental condition.
- **Condition O (Oracle):** Exact minimal context is injected directly. This is the theoretical performance ceiling.

The hypothesis is `L_MOEL(K) < L_MOEL(N)`, ideally approaching `L_MOEL(O)`.

## Success Criteria

The framework is complete when:

1. A pipeline can run an agent on a task under all three conditions and produce a single `L_MOEL` score for each.
2. The correctness component passes a mutation check (agent changes must fail when dependencies are stubbed).
3. The jury ensemble uses at least 3 distinct model families with minority-veto enabled.
4. The trajectory loss is derived from a static dependency graph, not heuristics.
5. Token costs are tracked at the cache-prefill / cache-read / output level.
6. Statistical calibration is validated against a 20-task human-annotated dataset with max absolute error ≤ 1.5%.
7. Results are reproducible and exportable as structured JSON for downstream analysis.
