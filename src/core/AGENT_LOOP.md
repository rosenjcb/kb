# Agent Loop Conventions

## Overview

KB uses two loop patterns:

1. **`runIntentLoop`** — the primary harness. Wraps every intent command (`query`, `submit`, `validate`, `dispute`, `explain`) with retry, discovery escalation, and optional LLM reasoning. This is what the CLI uses.
2. **Domain-specific cycle loops** — deterministic multi-pass orchestration for commands with a fixed, known lifecycle (`kb init`, `kb publish`).
3. **`agentLoop`** — low-level async generator for autonomous tool-calling. Available for programmatic / SDK use; not used by the CLI.

---

## Part 1: Intent Loop (primary pattern)

**File:** `src/core/intent-loop.ts`

`runIntentLoop` is the single entry point for all five intent commands. It calls `DefaultIntentRouter.execute()` and, when the result is weak, iterates with a refined strategy before returning.

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
  maxIterations?: number        // default 3
  confidenceThreshold?: number  // default 0.7 — stop early when reached
  provider?: LLMProvider        // enables LLM semantic reasoning for validate
}

interface IntentLoopResult {
  result: IntentResult
  iterations: number   // how many router.execute() calls were made
  escalated: boolean   // true if depth was escalated or LLM reasoning ran
}
```

### Per-intent behaviour

| Intent | Retry? | Strategy |
|---|---|---|
| `query_truth` | Yes, up to `maxIterations` | Escalates `discoveryDepth` shallow→deep, doubles `limit` (max 20), on weak retrieval |
| `explain_change` | Yes, up to `maxIterations` | Same as query |
| `validate_fact` | One extra pass | If `uncertain/0.45` (docs found, token-overlap inconclusive): runs LLM semantic reasoning pass |
| `submit_fact` | No | Single pass — retrying a submit has idempotency risks |
| `dispute_fact` | No | Single pass |

**"Weak retrieval"** for query/explain means: zero results, fewer than 2 results, or the final retrieval checkpoint has `status: 'miss'` or `'error'`.

**LLM validation reasoning** (validate only, confidence 0.45):
1. Re-fetches evidence with `discoveryDepth: 'deep'`, limit 8
2. Calls LLM: `"SUPPORTED / NOT_SUPPORTED / UNCERTAIN + one-sentence explanation"`
3. `SUPPORTED` → `status: 'valid'`, confidence 0.72
4. `NOT_SUPPORTED` → `status: 'uncertain'`, confidence 0.3, suggests `kb submit`
5. `UNCERTAIN` → keeps original result, no override

### CLI wiring (`src/cli/index.ts`)

All intent commands go through the loop:

```typescript
const { result } = await runIntentLoop(parsed.envelope, toolExecutor, { provider: llmProvider })
const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, llmProvider)
console.log(formatIntentResult(enriched, parsed.output))
```

LLM answer enrichment (`enrichReadDocumentsAnswerWithLLM`) runs **after** the loop on the final result — it generates a prose answer for `query`/`explain` from retrieved evidence.

### When to extend the intent loop

Add a new iteration strategy when:
- A new intent returns a result quality signal that isn't captured by `confidence` alone
- An intent could benefit from query reformulation (e.g., stripping domain prefix on retry)
- You need carryover from one intent to seed a follow-up (e.g., validated doc IDs passed to submit)

Do **not** retry:
- Mutation intents (`submit`, `dispute`) — idempotency
- Intents that already escalate internally (`validate` already does shallow→deep in the evaluator)

---

## Part 2: Domain-Specific Cycle Loops

Some commands implement their own deterministic loops over named **cycles**. LLM is called directly via `provider.call()` — not via the intent loop — because the orchestration is owned by the command, not delegated to the model.

### `kb init` — 7-cycle interview + enrichment loop

**File:** `src/cli/init-cli.ts`

| Cycle | What happens | Output |
|---|---|---|
| `read-inputs` | Scan source files, ask user interview questions | `InitContext` |
| `pass1` | LLM drafts 5–15 candidate docs from source files + Q&A (temperature 0.2) | `CandidateDoc[]` |
| `pass2` | Coverage gap analysis, follow-up questions, LLM refinement (temperature 0.1) | Updated `CandidateDoc[]` |
| `pass-enrich` | **Per-document enrichment** — each doc gets its own LLM pass in parallel (temperature 0.15) | Enriched `CandidateDoc[]` |
| `pass-consolidate` | **Consolidation agent** — single LLM pass merges docs with >40% overlap (temperature 0.1) | Deduplicated `CandidateDoc[]` |
| `pass3` | Final quality pass — validate titles, remove stubs, ensure uniqueness (temperature 0.0) | Final `CandidateDoc[]` |
| `write` | Upsert to SQLite | Written document IDs |

Each cycle writes a checkpoint to `~/.kb/<base>/checkpoints/init-latest.checkpoint.json`. Supports `--resume`, `--detach`, `--stop-after`, `--non-interactive`.

Interview question budget: max 10 total, max 4 follow-ups. Topics: `project-overview`, `install-setup`, `core-workflows`, `architecture`, `configuration`, `testing`, `deployment-release`, `constraints-gotchas`.

#### Per-document enrichment (`pass-enrich`)

After synthesis and follow-up refinement, each candidate document is independently enriched by a dedicated LLM call. All docs are processed **in parallel** (`Promise.all`) since they are independent. Each call:

1. Receives the full source file context + Q&A alongside the single doc
2. Fills gaps with concrete facts, commands, config keys, or examples from context
3. Removes internal redundancy — each fact appears once within the document
4. Keeps the document focused on its single topic (does not pull in unrelated content)

This is distinct from `pass2` (which refines all docs together with a holistic view) — `pass-enrich` gives each doc undivided attention with the full source context available.

#### Consolidation agent (`pass-consolidate`)

A single LLM call receives **all** enriched docs and identifies overlapping groups. The consolidation agent:

1. Finds pairs/groups with >40% content overlap or the same subject framed differently
2. Merges overlapping groups into one document — combines unique facts, removes duplicates, picks the most specific title
3. Leaves genuinely distinct docs untouched
4. Preserves all unique facts — consolidation removes redundancy, not information

The before/after count is reported in the progress bar (e.g. `3 docs merged → 9 total`).

### `kb chat` — tiered retrieval loop

**File:** `src/cli/chat-cli.ts`

Each turn runs a deterministic recovery stack — no agentLoop, no intent loop:

```
read_documents (shallow)
  → if confidence < 0.45: recovery query (simplified tokens)
  → LLM completion (temperature 0.15, maxTokens 4096)
  → if answer looks insufficient: deep discovery promotion (3× limit)
  → if still insufficient: focused evidence query (CLI-keyword rewrite)
  → if still insufficient: surface explicit message
```

---

## Part 3: Core `agentLoop` (programmatic use)

**File:** `src/core/agent-loop.ts`

A low-level `AsyncGenerator<AgentEvent>` for autonomous LLM tool-calling. The LLM decides which tools to call and for how many turns. **Not used by the CLI** — available for SDK consumers and testing.

```typescript
for await (const event of agentLoop(query, provider, toolExecutor, { maxTurns: 5 })) {
  if (event.type === 'text') process.stdout.write(event.content)
  if (event.type === 'done') break
}
```

Event types: `text`, `tool_start`, `tool_result`, `metadata`, `done`.

Config: `maxTurns` (default 10), `maxTokens`, `temperature`.

Use `agentLoop` when you need fully autonomous, open-ended tool orchestration and are building outside the intent command system. For anything in the KB CLI, use `runIntentLoop` or a cycle loop instead.

---

## Part 4: Choosing a Pattern

| Situation | Use |
|---|---|
| Any intent command (`query`, `submit`, `validate`, `dispute`, `explain`) | `runIntentLoop` |
| Fixed sequence of LLM passes with known inputs/outputs | Cycle loop (`kb init` pattern) |
| User interaction between LLM calls (interview, confirmation) | Cycle loop |
| Autonomous open-ended tool use in SDK/programmatic context | `agentLoop` |
| Single LLM completion, no tools | `provider.call()` directly |

---

## Part 5: Implementing a New Cycle Loop

1. Define cycles as a union type: `type MyCycle = 'read' | 'draft' | 'write'`
2. Define a versioned checkpoint interface with `completedCycles: MyCycle[]`
3. Persist checkpoint before advancing each cycle
4. Skip already-completed cycles: `if (!checkpoint.completedCycles.includes(cycle))`
5. Throw a `PausedError` instead of returning when pausing mid-run
6. Support `--stop-after`, `--resume`, `--detach`, `--non-interactive`
7. Log progress to stderr: `[init] [====----] 2/5 pass1 12 candidate docs`
8. Use decreasing temperature: 0.2 (draft) → 0.1 (refine) → 0.0 (validate)

---

## See Also

- `src/core/intent-loop.ts` — primary intent harness
- `src/core/agent-loop.ts` — low-level async generator
- `src/cli/index.ts` — CLI wiring for all commands
- `src/cli/init-cli.ts` — reference cycle loop
- `src/cli/chat-cli.ts` — tiered retrieval loop
- `src/tools/TOOL_CONVENTIONS.md` — tool design patterns
- `src/core/types.ts` — `AgentEvent`, `LLMProvider`, `Message` types
- `src/intents/router.ts` — `DefaultIntentRouter` used by the intent loop
