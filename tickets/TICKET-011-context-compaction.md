# TICKET-011: Context Compaction & Runaway Limits

**Status:** Open  
**Priority:** P2  
**Language:** TypeScript / MJS  
**Labels:** evaluation, infrastructure, cost-control

## Context

Under Condition N (raw filesystem), agents can spiral into runaway execution: reading large files
repeatedly, filling the context window, and then failing because earlier content is truncated.
Without guardrails, a single runaway Condition N run can exhaust the token budget for an entire
experiment batch.

Condition K and O are not expected to need compaction — `kb`'s fact-based architecture inherently
provides compression (facts are compact summaries, not raw file dumps). If Condition K triggers
compaction, that is itself a notable finding worth logging.

## Critical Architectural Constraint: No Harness-Level Context Window

`eval-run.mjs` does **not** maintain a conversation history array. It drives `kb` as a subprocess
via `execSync` (see the `kb()` helper at line 297 of `scripts/eval-run.mjs`). Conversation state is
managed entirely inside the Claude Code session process — the harness has no access to the message
array, no token counts per turn, and no way to intercept or rewrite conversation history between
turns.

Concretely:

```js
// eval-run.mjs line 297 — the entire harness↔Claude interface
function kb(cwd, args, opts = {}) {
  const bin = path.join(KB_REPO, 'dist/bin/kb.js')
  return execSync(`node "${bin}" ${args}`, { ... })
}
```

Each `kb query` call is a one-shot subprocess invocation. Token counts returned by individual turns
are not surfaced to the harness — `execSync` returns only stdout text, which for `kb query` is the
prose answer format parsed by `parseQueryText()`. There is no JSON token field in that output and
no streaming delta to intercept.

Similarly, there is no `--context-window` or `--max-tokens` flag in the `kb` CLI that would let the
harness externally cap the Claude Code session's context.

**Conclusion: full context compaction (intercept turn N, summarize large tool results, inject
compressed history into turn N+1) is not implementable at the harness level given the current
subprocess architecture.** Implementing it would require either (a) invasive refactoring of
`moel-run.mjs` to drive agent turns in-process via the `AnthropicProvider` API directly, or (b)
exposing a token-count streaming interface from the `kb` subprocess, neither of which is in scope
for this ticket.

## Revised Objective

Implement the **runaway ceiling** mechanism in `scripts/moel-run.mjs` (TICKET-010) and record
compaction-related telemetry fields so the schema is ready for a future in-process agent
implementation. Remove the compaction execution criteria from this ticket's acceptance criteria; keep
the step ceiling and token budget ceiling as the primary deliverables.

## Acceptance Criteria

### Runaway Ceilings (Implementable)

- [ ] If `totalSteps > stepCeiling` (default 20), the run terminates. Report records
      `terminatedBy: "step_ceiling"`.
- [ ] If `weightedTokenTotal > tokenBudget` (default 250,000), the run terminates. Report records
      `terminatedBy: "token_budget"`.
- [ ] Terminated runs receive `lTrajectory = 1.0` and `lResource = 1.0`. `lCorrectness` is computed
      on the partial output produced before termination.
- [ ] Both ceilings are configurable via task YAML fields `stepCeiling` and `tokenBudget`.
- [ ] Ceiling checks happen at the start of each agent turn, before the turn is executed.

**Note on token counting:** Because the harness drives `kb` via subprocess, token tracking must be
derived from the trajectory records written by `TrajectoryCollector` (TICKET-001), not from live API
responses. Each trajectory step must expose a `freshTokens` field (input + output tokens for that
turn). The harness reads this from the trajectory JSON after each turn completes, not from a
streaming response.

### Schema Placeholders for Future Compaction (Implementable Now)

- [ ] The `MoelResult` report schema includes a `compaction` field: `{ triggered: boolean,
      events: CompactionEvent[] }`.
- [ ] `CompactionEvent` shape: `{ stepIndex: number; tokensFreed: number; turnsCompacted: number;
      condition: 'N' | 'K' | 'O' }`.
- [ ] If no compaction occurred (the expected case in this implementation), `compaction.triggered` is
      `false` and `compaction.events` is `[]`.
- [ ] If Condition K or O somehow logs a compaction event, emit a warning to stderr:
      `[moel] WARNING: compaction triggered for Condition K/O — notable finding`.

### What Is NOT In Scope (Requires In-Process Architecture)

The following items from the original ticket are **deferred** until `moel-run.mjs` drives agent
turns in-process rather than via subprocess:

- Automatic summarization of large `read_file` tool results.
- Replacing tool result content in conversation history.
- Haiku-class summary call at 95% context pressure.
- `__compaction__` synthetic trajectory steps with actual `tokensFreed`.
- Triggered-at-95%-context-window logic.

## Implementation Notes

### Token Budget Tracking Without Streaming

The harness cannot observe tokens mid-session. The practical approach is:

1. After each `kb query` subprocess call returns, read the latest entry appended to the trajectory
   JSON file by `TrajectoryCollector`.
2. Sum `freshTokens` from all trajectory steps for this run into `weightedTokenTotal`.
3. Apply ceiling check before launching the next turn.

This means the ceiling check is one turn delayed relative to what the original ticket described. A
run will exceed the budget by at most one turn's worth of tokens before termination is triggered.
This is acceptable given that the ceiling is a safety net, not a hard real-time cutoff.

### Step Ceiling

Step counting is straightforward: `TrajectoryCollector` writes one entry per tool call. Count
entries in the trajectory JSON and compare to `stepCeiling` before each new `kb query` invocation.

### Cheapest Available Anthropic Model

If a future in-process compaction call is implemented, the cheapest model available via
`AnthropicProvider` is `claude-haiku-4-5` — this is the default in the `AnthropicProvider`
constructor (see `src/core/llm-provider.ts` line 53):

```ts
constructor(private apiKey: string, model = 'claude-haiku-4-5') {
```

The `KbConfig` interface (in `src/cli/kb-config.ts`) does not define an Anthropic model override
field — `llm.openaiModel`, `llm.geminiModel`, and `llm.ollamaModel` exist, but there is no
`llm.anthropicModel` knob. A compaction call would therefore hardcode `claude-haiku-4-5` or read a
new `llm.anthropicModel` config field that would need to be added.

### Condition N Trajectory Observation

Under Condition N the agent receives `read_file`, `list_directory`, and `search_file_contents` tool
wrappers (see TICKET-010 `eval/tools/filesystem-tools.ts`). Every `read_file` call should record
the approximate character count of the returned content in the trajectory step so that future
compaction logic can identify high-value compaction targets without re-reading history.

Add `contentLengthChars: number` (optional) to the trajectory step type for filesystem tool
results.

### Turn Output Structure

A "turn" in the `eval-run.mjs`/`moel-run.mjs` context is a single `kb query` subprocess call. The
output is prose text, parsed by `parseQueryText()` into:

```js
{
  answer: string | null,
  result_count: number,
  provenance: string[],
  retrieval: { method: string | null, detail: string | null, confidence: null }
}
```

There is no per-turn token count in this structure. For `moel-run.mjs`, each agent turn is a
multi-step agentic loop (potentially many tool calls before producing a final answer). The
trajectory JSON from `TrajectoryCollector` captures each individual tool call as a step; the ceiling
checks operate on that granular step count, not on the number of `kb query` invocations.

## Files to Modify

- `scripts/moel-run.mjs` (TICKET-010) — add ceiling check loop before each turn dispatch
- `eval/tools/filesystem-tools.ts` (TICKET-010) — add `contentLengthChars` to tool result type

## Files to Create

- `eval/compaction.ts` — `CompactionEvent` type definition and `buildEmptyCompactionRecord()`
  factory (no execution logic yet; schema-only for this ticket)

## Dependencies

TICKET-010, TICKET-001 (TrajectoryCollector with `freshTokens` per step)

## Feeds Into

TICKET-012

## Future Work: Path to Real Compaction

Genuine context compaction requires one of:

1. **In-process agent loop in `moel-run.mjs`:** Instead of calling `kb` as a subprocess, drive the
   agent loop directly using `AnthropicProvider.call()` with a managed `messages` array. The
   harness would then own the history and could rewrite tool result content before appending. This
   is a significant architectural change to `moel-run.mjs` but is the cleanest path.

2. **A streaming token-count side-channel from the `kb` subprocess:** The `kb` process could write
   incremental telemetry (token counts, step indices) to a named pipe or temp file that `moel-run.mjs`
   polls. This is fragile and not recommended.

Option 1 is the right long-term direction. This ticket lays the schema groundwork so the
`MoelResult` type is ready when that refactoring lands.
