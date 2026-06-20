---
type: "Reference"
title: "MOEL Benchmark Alignment"
description: "How the MOEL evaluation framework maps onto established external software-agent benchmarks."
resource: ./eval/benchmarks
tags: [eval, benchmarks, alignment]
timestamp: 2026-06-20T00:00:00Z
---

# MOEL Benchmark Alignment

How the MOEL evaluation framework maps to established external benchmarks.

---

## SWE Atlas

SWE Atlas evaluates software engineering agents on real-world GitHub issues, requiring programmatic
verification that code changes are correct, complete, and non-regressive.

**Manifest + mutation checks (TICKET-009):**
- MOEL's `ManifestValidator` satisfies SWE Atlas's requirement that agents declare the set of files
  they modified. SWE Atlas validates this declaration against a static reference manifest; MOEL
  validates it against the live `git diff --name-only HEAD` output, making it harder to game
  (agents cannot pre-declare files they aren't actually modifying).
- MOEL's `MutationValidator` goes beyond static reference text matching: it applies tree-sitter
  AST body replacement and verifies that the test suite fails when targeted dependencies are stubbed.
  This confirms causal linkage between agent changes and test coverage — SWE Atlas uses reference
  test execution but does not specifically test for causal stubbing.

**AST distance vs. static text matching:**
- SWE Atlas correctness scores are typically binary (tests pass / fail). MOEL's `L_AST` (AST
  structural loss) measures the Jaccard distance between named exports in the candidate and
  reference code, providing a continuous similarity signal even when tests pass. This enables
  partial-credit scoring for implementations that are structurally close but not identical.
- Difference: SWE Atlas targets production defect resolution; MOEL targets knowledge retrieval
  tasks. Correctness in MOEL is LLM-judged (`L_jury`) and structurally verified (`L_AST`), not
  execution-verified against a benchmark test suite.

---

## SWE-ContextBench

SWE-ContextBench measures how agents use context efficiently when resolving software engineering
tasks, tracking token consumption and cache-hit ratios across different context strategies.

**L_resource and trajectory tracking:**
- `L_resource` directly mirrors SWE-ContextBench's token-efficiency metric. The formula
  `C_fresh + δ·C_cached + γ·C_output` with `δ=0.1` (cached-token discount) matches the prompt
  caching discount ratio used by Anthropic's API, making it directly comparable to cost-efficiency
  measurements in SWE-ContextBench experiments.
- `L_trajectory` tracks redundant tool calls (duplicate tool+args pairs) and step count — this
  corresponds to SWE-ContextBench's "time-efficiency" metric, which penalizes agents that make
  unnecessary API calls or revisit the same context repeatedly.

**Condition comparison (N vs K):**
- SWE-ContextBench experiments typically compare a "no context" baseline against various context
  injection strategies. MOEL's three-condition design (N=raw filesystem, K=kb-enabled, O=oracle)
  maps directly: Condition N is the "no context" baseline, Condition K is the "structured context"
  experiment, and Condition O is the theoretical upper bound.
- Difference: SWE-ContextBench measures task completion rate as primary outcome; MOEL measures
  exploration efficiency (`L_trajectory`, `L_resource`) as primary outcomes alongside correctness.

---

## CodeScaleBench

CodeScaleBench evaluates agents across tasks of varying scale and complexity, using a three-tier
validity framework: task validity (is the task well-defined?), outcome validity (did the agent
produce a correct result?), and tool validity (did the agent use appropriate tools?).

**Three-condition comparison (K/N/O):**
- MOEL's Condition N (raw filesystem), K (kb-enabled), and O (oracle) map directly to
  CodeScaleBench's tool validity tier. Condition N verifies baseline task completion using only
  primitive tools; Condition K tests whether structured knowledge tools improve outcomes; Condition
  O establishes the outcome ceiling when minimal relevant context is directly injected.
- `compareConditions()` in `eval/losses/moel.ts` checks the hypothesis `L_MOEL(N) > L_MOEL(K)`,
  which is equivalent to CodeScaleBench's tool validity assertion that augmented tool sets should
  reduce exploration cost without degrading outcome quality.

**Explicit differences from CodeScaleBench:**
1. CodeScaleBench uses multi-step agentic tasks (build systems, CI pipelines, dependency graphs);
   MOEL targets single-turn knowledge retrieval tasks on a fixed codebase.
2. CodeScaleBench's outcome validity is primarily execution-based (does the CI pass?); MOEL's is
   LLM-judged (`L_jury`) with structural augmentation (`L_AST`).
3. CodeScaleBench includes scale as an explicit variable (small/medium/large repositories); MOEL
   uses a fixed repository (the kb repo itself) and measures effort per task, not per repository
   scale class.
4. CodeScaleBench does not distinguish between cached and fresh tokens; MOEL's `L_resource` formula
   weights them differently to reflect real API pricing structures.

---

## Summary Table

| Aspect | SWE Atlas | SWE-ContextBench | CodeScaleBench | MOEL |
|--------|-----------|------------------|----------------|------|
| Task type | Real GH issues | Context-efficiency | Multi-scale engineering | Knowledge retrieval |
| Correctness signal | Test execution | Task completion | Build/CI pass | L_jury + L_AST |
| Efficiency signal | Not primary | Token cost + cache | Tool validity tier | L_trajectory + L_resource |
| Baseline condition | No agent | No context injection | Primitive tools | Condition N (raw FS) |
| Augmented condition | Agent w/ tools | Context injection | Augmented tools | Condition K (kb) |
| Upper bound | N/A | Oracle context | N/A | Condition O (injected facts) |
| Programmatic check | Reference tests | N/A | CI execution | Manifest + mutation validator |
