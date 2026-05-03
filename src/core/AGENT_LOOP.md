# Agent Loop Conventions

## Overview

KB uses three loop patterns:

1. **`runIntentLoop`** — the primary harness for the public KB intents: one read intent (`query`) and two mutation intents (`submit`, `invalidate`).
2. **Domain-specific cycle loops** — deterministic multi-pass orchestration for commands with a fixed lifecycle such as `kb init` and `kb publish`.
3. **`agentLoop`** — low-level async generator for autonomous tool-calling. Available for programmatic / SDK use; not used by the CLI.

The public KB intents delegate their core logic to orchestrators:

| Intent | Orchestrator | Location |
|---|---|---|
| `query_truth` | Router-owned retrieval path | `src/intents/router.ts` |
| `submit_fact` | `SubmitOrchestrator` | `src/tools/submit-orchestrator.ts` |
| `invalidate_fact` | `InvalidateOrchestrator` | `src/tools/invalidate-orchestrator.ts` |

This is the composition principle: `intent → orchestrator → tools`. `runIntentLoop` owns retry policy; orchestrators own multi-step behavior; CLI/TUI adapters stay thin.

## Intent Surface

```mermaid
flowchart LR
  Q["kb query / /query"] --> R["read_facts\nfact FTS + deep facts loop"]
  R --> G["graph query expansion\n+ typed edge hints"]
  G --> A["grounded answer"]

  S["kb submit / /submit"] --> SO["SubmitOrchestrator"]
  SO --> W["discover target + upsert fact"]
  W --> SG["extract + upsert graph"]

  I["kb invalidate / /invalidate"] --> IO["InvalidateOrchestrator"]
  IO --> P["preview/apply KB mutation"]
  P --> IG["soft-delete graph provenance"]
```

## Part 1: Intent Loop

**File:** `src/core/intent-loop.ts`

`runIntentLoop` is the entry point for the full public KB intent surface: one read intent plus two mutation intents.

### Signature

```typescript
runIntentLoop(
  envelope: ConsumerIntentEnvelope,
  toolExecutor: ToolExecutor,
  config?: IntentLoopConfig,
): Promise<IntentLoopResult>
```

```typescript
interface IntentLoopConfig {
  maxIterations?: number
  confidenceThreshold?: number
  provider?: LLMProvider
}

interface IntentLoopResult {
  result: IntentResult
  iterations: number
  escalated: boolean
}
```

### Per-intent behaviour

| Intent | Retry? | Strategy |
|---|---|---|
| `query_truth` | Yes, up to `maxIterations` | Router defaults to deep discovery; weak retrieval escalates to deep with a wider limit. |
| `submit_fact` | No | Single pass — mutation flow is orchestrator-owned and graph sync happens inside `SubmitOrchestrator`. |
| `invalidate_fact` | No | Single pass — preview/apply and graph invalidation are orchestrator-owned. |

Weak retrieval for query means zero results, fewer than two results, or a final retrieval checkpoint with `status: 'miss'` or `'error'`.

### Query sequence

```mermaid
sequenceDiagram
  autonumber
  participant U as CLI / TUI
  participant L as runIntentLoop
  participant R as DefaultIntentRouter
  participant D as read_facts
  participant G as Graph augmentation

  U->>L: query_truth envelope
  L->>R: execute(query_truth)
  R->>D: read_facts(query, discoveryDepth, limit)
  D->>G: query expansion / hints when graph enabled
  G-->>R: grounded retrieval results
  R-->>L: IntentResult
  L-->>U: answer-ready result
```

### CLI wiring

All KB intents go through the same loop. Query-specific answer enrichment runs afterward only for the read intent.

## Part 2: Domain-Specific Cycle Loops

Some commands implement deterministic loops over named cycles. LLM is called directly via `provider.call()` because the command owns the orchestration.

### `kb init`

| Cycle | What happens | Output |
|---|---|---|
| `read-inputs` | Scan source files, ask user interview questions | `InitContext` |
| `pass1` | One LLM call per coverage topic in parallel | `CandidateDoc[]` |
| `pass2` | Coverage gap analysis, follow-up questions, refinement | Updated `CandidateDoc[]` |
| `pass-enrich` | Per-document enrichment in parallel | Enriched `CandidateDoc[]` |
| `pass3` | Final quality pass | Final `CandidateDoc[]` |
| `write` | Upsert to SQLite | Written document IDs |
| `pass-graph` | Extract entities and relationships into DuckDB | Graph store on disk |

## Part 3: Choosing a Pattern

| Situation | Use |
|---|---|
| Public KB intent (`query`, `submit`, `invalidate`) | `runIntentLoop` |
| Fixed sequence of LLM passes with known inputs/outputs | Cycle loop |
| User interaction between LLM calls | Cycle loop |
| Autonomous open-ended tool use in SDK/programmatic context | `agentLoop` |
| Single LLM completion, no tools | `provider.call()` directly |

## See Also

- `src/core/intent-loop.ts` — primary intent harness
- `src/cli/intent-cli.ts` — public intent parsing and formatting
- `src/tools/submit-orchestrator.ts` — KB write + graph sync
- `src/tools/invalidate-orchestrator.ts` — KB invalidation + graph cleanup
- `src/tools/GRAPH.md` — graph lifecycle and read/write semantics
