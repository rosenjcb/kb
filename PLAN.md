# MOEL Evaluation Framework — Project Plan

## What We're Building

This project implements a **Multi-Objective Exploration Loss (MOEL)** evaluation framework to rigorously measure whether `kb`'s structured codebase indexing makes developer agents more efficient.

The core claim we want to prove: agents equipped with `kb`'s fact index produce functionally equivalent answers using fewer steps and fewer tokens than agents navigating a raw filesystem. Proving this requires moving beyond "did the answer score well?" to a framework that captures *how* the agent got there.

## The Problem

Current evaluation approaches have two failure modes:

1. **Outcome-only measurement** — pass/fail or rubric scores ignore the cost of exploration. An agent that reads 40 files before answering a question and one that queries two facts are indistinguishable under a binary quality signal.

2. **LLM-as-judge bias** — judges rubber-stamp incorrect answers, with True Negative Rates below 25%. Qualitative scoring without structural grounding is not a reliable signal.

MOEL addresses both by combining three normalized loss terms into a single weighted objective:

```
L_MOEL = w_c · L_correctness + w_t · L_trajectory + w_r · L_resource
```

where `w_c + w_t + w_r = 1`.

## Architecture Constraints

This framework is built on top of the existing kb implementation. Key constraints:

- **Primary language is TypeScript.** The entire kb source (`src/`) is TypeScript. All evaluation harness code, loss functions, telemetry extensions, and validation logic is TypeScript.
- **Python is delegated to statistical computation only.** The existing pattern (see `requirements/fact-category-clustering.txt`, auto-installs to `~/.kb/.kb-python`) is used for the logistic regression calibration in TICKET-008. Python is not used elsewhere.
- **Significant eval infrastructure already exists.** `scripts/eval-run.mjs` is a 1300+ line evaluation harness with session lifecycle management, auto-scoring, and YAML task suites. New work extends this, it does not replace it.
- **Telemetry already exists.** `src/core/telemetry.ts` tracks per-stage tokens, costs, and run reports via `pricetoken`. TICKET-001 extends it with per-step trajectory logging, not a full rebuild.
- **tree-sitter is already TypeScript.** kb uses `web-tree-sitter` (WASM) extensively in `src/tools/tree-sitter-indexer.ts`. The AST loss function uses the same runtime — no Python tree-sitter.
- **LLM providers are already abstracted.** `src/core/llm-provider.ts` provides `AnthropicProvider`, `OpenAIProvider`, and `GeminiProvider` behind a common interface. The jury ensemble uses these directly.
- **kb's agent surface is facts-based.** The tools exposed to agents are `read_facts`, `upsert_fact`, `search_code_symbols`, `get_code_neighbors`, and `get_code_graph_summary` — not class skeletons or markdown documentation blocks.
- **Task format is YAML.** Existing eval suites in `eval/suites/*.yaml` define questions and reference answers. New tasks extend this format.

## How the Tickets Solve It

The tickets decompose the framework into independently deliverable components, ordered by dependency.

```
Extend Telemetry (001)
    │
    ├─► AST Loss in TS (002) ────────────┐
    │                                    │
    ├─► LLM Jury via LLMProvider (003) ──┼─► MOEL Aggregator (006)
    │                                    │         │
    ├─► Trajectory Loss (004) ───────────┤         │
    │                                    │         ▼
    └─► Resource Loss via pricetoken (005)┘   Extend eval-run.mjs (010)
                                                   │
    Bias Mitigation (007) ──────────────►  Calibration in Python (008)
    Manifest & Mutation Checks (009) ──►          │
    Context Compaction (011) ──────────►          │
    Benchmark Alignment (012) ─────────────────────┘
```

### Ticket Index

| Ticket | Title | Language | Depends On | Status |
|--------|-------|----------|------------|--------|
| [001](tickets/TICKET-001-telemetry-instrumentation.md) | Extend Telemetry with Trajectory Tracking | TypeScript | — | ✅ Implemented |
| [002](tickets/TICKET-002-ast-structural-loss.md) | AST Structural Loss (`L_AST`) | TypeScript | 001 | ✅ Implemented |
| [003](tickets/TICKET-003-llm-jury-semantic-loss.md) | LLM Jury Semantic Loss (`L_jury`) | TypeScript | 001 | ✅ Implemented |
| [004](tickets/TICKET-004-trajectory-inefficiency-loss.md) | Trajectory Inefficiency Loss (`L_trajectory`) | TypeScript | 001 | ✅ Implemented |
| [005](tickets/TICKET-005-resource-consumption-loss.md) | Resource Consumption Loss (`L_resource`) | TypeScript | 001 | ✅ Implemented |
| [006](tickets/TICKET-006-moel-aggregator.md) | MOEL Aggregator | TypeScript | 002, 003, 004, 005 | ✅ Implemented |
| [007](tickets/TICKET-007-bias-mitigation.md) | LLM Judge Bias Mitigation | TypeScript | 003 | ✅ Implemented |
| [008](tickets/TICKET-008-statistical-calibration.md) | Statistical Calibration Framework | **Python** | 007 | Open |
| [009](tickets/TICKET-009-manifest-mutation-checks.md) | Programmatic Validation (Manifest & Mutation) | TypeScript | 001 | Open |
| [010](tickets/TICKET-010-evaluation-harness.md) | Extend eval-run.mjs with MOEL Conditions | TypeScript | 006, 009 | Open |
| [011](tickets/TICKET-011-context-compaction.md) | Context Compaction & Runaway Limits | TypeScript | 010 | Open |
| [012](tickets/TICKET-012-benchmark-alignment.md) | Benchmark Tasks & Alignment Suite | TypeScript + YAML | 010, 011 | Open |

## Three Evaluation Conditions

Every task runs under three controlled conditions to isolate the contribution of `kb`:

- **Condition N (Baseline FS):** Agent has only raw filesystem tools (`read_file`, `list_directory`, `search_file_contents`). No `kb` tools. This is the worst-case exploration baseline.
- **Condition K (kb-Enabled):** Agent has access to the kb tool registry: `read_facts`, `search_code_symbols`, `get_code_neighbors`, `get_code_graph_summary`. This is the primary experimental condition.
- **Condition O (Oracle):** The minimal set of kb facts that cover the task's target symbols is injected directly as a structured context block in the system prompt. No exploratory tools. This is the theoretical performance ceiling.

Note: Condition O pulls from the kb SQLite fact store, not raw files. The injected context is the same compressed, structured fact representation that kb produces — not file dumps.

The hypothesis is `L_MOEL(K) < L_MOEL(N)`, ideally approaching `L_MOEL(O)`.

## Relationship to Existing Eval Infrastructure

`scripts/eval-run.mjs` already handles:
- Session lifecycle (`eval-{suiteId}` base naming)
- YAML task suite loading
- LLM auto-scoring (4 axes via Gemini/OpenAI)
- Artifact output to `~/.kb/evaluations/<run-name>/artifact.json`
- Trends comparison across runs

The new MOEL harness (TICKET-010) adds a second script `scripts/moel-run.mjs` that runs the same tasks across all three conditions, feeds each run through the MOEL loss pipeline, and emits structured comparison reports. It does not replace `eval-run.mjs`.

## Language Split Summary

| Component | Language | Reason |
|-----------|----------|--------|
| Telemetry extension | TypeScript | Extends `src/core/telemetry.ts` |
| AST loss | TypeScript | Reuses `web-tree-sitter` already in the project |
| LLM jury | TypeScript | Reuses `src/core/llm-provider.ts` |
| Trajectory loss | TypeScript | Pure logic over trajectory arrays |
| Resource loss | TypeScript | Reuses `pricetoken` already in `package.json` |
| MOEL aggregator | TypeScript | Pure math over floats |
| Bias mitigation | TypeScript | Extends jury |
| Statistical calibration | **Python** | Logistic regression via `scikit-learn` — follows existing `requirements/fact-category-clustering.txt` pattern |
| Manifest validator | TypeScript | Parses git output, JSON |
| Mutation validator | TypeScript + shell | Drives Vitest, patches source via tree-sitter |
| Eval harness | TypeScript | Extends `eval-run.mjs` |
| Context compaction | TypeScript | Integrates with harness turn loop |
| Benchmark tasks | YAML + TypeScript | YAML extends existing `eval/suites/*.yaml` format |

## Success Criteria

The framework is complete when:

1. A single command runs a task under all three conditions and emits a `L_MOEL` score per condition.
2. The correctness component passes a Vitest-based mutation check.
3. The jury ensemble uses at least 3 distinct model families with minority-veto enabled.
4. The trajectory loss is derived from the kb fact graph, not heuristics.
5. Token costs use the existing `pricetoken` integration extended with per-step trajectory data.
6. Statistical calibration is validated against a 20-task human-annotated dataset with max absolute error ≤ 1.5%.
7. Results are reproducible and exportable as structured JSON for downstream analysis.
