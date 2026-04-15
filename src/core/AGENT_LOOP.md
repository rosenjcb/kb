# Agent Loop Conventions

## Overview

KB uses two complementary loop patterns:

1. **The core `agentLoop`** — a generic, streaming, tool-calling loop used when an LLM needs to call tools autonomously over multiple turns.
2. **Domain-specific interview / cycle loops** — deterministic orchestration of LLM passes and user Q&A used when a command's lifecycle is well-known ahead of time (e.g. `kb init`, `kb publish`).

Both patterns share the same primitives: `LLMProvider`, message history, and `ToolExecutor`. Choose based on whether the number of turns and branching is data-driven (generic loop) or statically defined (cycle loop).

---

## Part 1: Core `agentLoop` (generic tool-calling)

**File:** `src/core/agent-loop.ts`

### What it does

`agentLoop` is an `AsyncGenerator<AgentEvent>` that drives a single LLM ↔ tool round-trip loop. It yields structured events as they occur so callers can stream output, collect results, or build a UI.

### Event types

| Event type     | When emitted                                    | Key fields                                      |
|----------------|-------------------------------------------------|-------------------------------------------------|
| `text`         | Each LLM response that contains prose           | `content: string`                               |
| `tool_start`   | Before each tool is executed                    | `toolName`, `toolUseId`                         |
| `tool_result`  | After each tool finishes (success or error)     | `toolUseId`, `result`, `isError: boolean`       |
| `metadata`     | Once per turn, after LLM response               | `usage.inputTokens`, `usage.outputTokens`       |
| `done`         | Loop exits (no more tool calls or limit hit)    | `reason: 'no_tool_calls' \| 'max_turns_reached'` |
| `error`        | Unhandled exception in the loop                 | (throw propagates to caller)                    |

### Lifecycle

```
user query
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  turn N                                             │
│  1. LLM call (messages + tools)                     │
│  2. yield { type: 'text' }                          │
│  3. yield { type: 'metadata' }                      │
│  4. for each tool call:                             │
│       yield { type: 'tool_start' }                  │
│       execute tool                                  │
│       yield { type: 'tool_result' }                 │
│  5. append assistant response + tool results        │
│     to message history                              │
│  6. if no tool calls → yield done, break            │
│  7. if turn >= maxTurns → yield done, break         │
└──────────────────────────── loop ──────────────────┘
```

### Configuration

```typescript
interface AgentLoopConfig {
  maxTurns?: number    // default 10 — hard ceiling on loop iterations
  maxTokens?: number   // passed through to LLM call
  temperature?: number // passed through to LLM call
}
```

### Usage — streaming

```typescript
import { agentLoop } from '../core/agent-loop'

for await (const event of agentLoop(query, provider, toolExecutor)) {
  if (event.type === 'text') process.stdout.write(event.content)
  if (event.type === 'tool_result' && event.isError) console.error(event.result)
  if (event.type === 'done') break
}
```

### Usage — collect all events

```typescript
import { runAgent } from '../core/agent-loop'

const events = await runAgent(query, provider, toolExecutor, { maxTurns: 5 })
const texts = events.filter(e => e.type === 'text').map(e => e.content).join('')
```

### When to use `agentLoop`

Use `agentLoop` when:
- The LLM decides which tools to call and in what order (fully autonomous)
- The number of turns is unbounded / data-driven
- You need streaming events for CLI output or a UI

Do **not** use `agentLoop` when:
- You know the exact sequence of LLM calls ahead of time → use a cycle loop instead
- You only need a single LLM completion with no tool calls → call `provider.call()` directly

---

## Part 2: Interview / Cycle Loops (domain-specific orchestration)

Some commands implement their own deterministic loops over named **cycles**. Each cycle has a clear input and output. LLM is called directly via `provider.call()` — not via `agentLoop` — because the orchestration logic is owned by the command, not delegated to the model.

### Pattern

```
cycle 1 → checkpoint → cycle 2 → checkpoint → ... → write
              │                       │
              └── persist to disk ────┘
              └── can detach / resume
```

### `kb init` — 5-cycle interview loop

**File:** `src/cli/init-cli.ts`

The canonical reference for this pattern. `kb init` bootstraps a knowledge base through five ordered cycles:

| Cycle         | What happens                                                                 | Output                                |
|---------------|------------------------------------------------------------------------------|---------------------------------------|
| `read-inputs` | Collect source files (README, CLAUDE.md, etc.) + ask user interview questions | `InitContext` (source files + Q&A)    |
| `pass1`       | LLM drafts 5–15 KB documents from source files and Q&A                        | `CandidateDoc[]`                      |
| `pass2`       | Assess topic coverage, ask follow-up questions, LLM refines documents         | Updated `CandidateDoc[]`              |
| `pass3`       | LLM quality pass — validate titles, remove short docs, ensure uniqueness      | Final `CandidateDoc[]`                |
| `write`       | Upsert all candidate docs to SQLite via `SqliteDocumentWriter`                | Written document IDs                  |

#### Interview round structure

Questions are typed by topic and reason:

```typescript
interface InitInterviewQuestion {
  id: string
  round: number
  topic: InitTopic   // 'project-overview' | 'install-setup' | 'core-workflows' | ...
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  question: string
  answer?: string
}
```

Topic definitions (`src/cli/init-topic-coverage.ts`) drive which questions are asked:
- **Round 1** — initial questions for topics not found in source files (keyword matching)
- **Round 2** — follow-up questions for topics rated low-confidence or unresolved after `pass1`

Hard limits: max 10 total questions, max 4 follow-ups.

#### Topic coverage assessment

After each cycle that produces documents, `assessTopicCoverage()` scores every topic:

```typescript
interface TopicCoverageAssessment {
  topic: InitTopic
  confidence: 'high' | 'medium' | 'low'
  status: 'sufficient' | 'needs-follow-up' | 'inferred-only' | 'unresolved'
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  enoughContext: boolean
}
```

#### Checkpoint and resume

Every cycle writes a checkpoint to disk before advancing:

```
.tmp/kb-init/<base>-latest.checkpoint.json
```

Checkpoint format is versioned (`version: 2`). V1→V2 migration is handled automatically. The checkpoint records:
- Which cycles completed (`completedCycles: InitCycle[]`)
- The current context, candidate docs, interview rounds, and topic coverage
- Working directory and base name

Resume flow:
```
kb init --base myproject --apply --resume
  └── reads checkpoint
  └── skips completed cycles
  └── resumes from last incomplete cycle
```

`--detach` mode pauses after each interview round instead of waiting for stdin, enabling async multi-session workflows.

#### LLM call patterns used in init

Each LLM pass is a single `provider.call()` returning JSON — not an agentic loop:

```typescript
// pass1: synthesis
const response = await provider.call({
  messages: [{ role: 'user', content: synthesisPrompt }],
  maxTokens: 4000,
  temperature: 0.2,  // some creativity for drafting
})

// pass2: refinement
const response = await provider.call({
  messages: [{ role: 'user', content: refinementPrompt }],
  maxTokens: 4000,
  temperature: 0.1,  // lower — we want controlled edits
})

// pass3: quality
const response = await provider.call({
  messages: [{ role: 'user', content: qualityPrompt }],
  maxTokens: 4000,
  temperature: 0.0,  // deterministic validation
})
```

Each pass parses the response as a JSON array of `CandidateDoc[]` with a regex-based extractor and falls back to a single-doc overview if parsing fails.

---

### `kb chat` — retrieval loop with recovery strategies

**File:** `src/cli/chat-cli.ts`

`kb chat` runs an infinite `while (true)` read-eval-print loop. Each turn uses a **tiered retrieval strategy** — not `agentLoop` — because the retrieval steps are deterministic and ordered:

```
user input
  │
  ├─ is it a long token / underscore-heavy? → deep discovery (2× limit)
  │
  ▼
read_documents (shallow or deep)
  │
  ├─ confidence < 0.45 or status=miss? → recovery query (simplified tokens)
  │                                        └─ merge results
  ▼
LLM completion (temperature 0.15, maxTokens 320)
  │
  ├─ answer looks insufficient? → deep discovery promotion (3× limit)
  │                                └─ deterministic fallback from raw evidence
  ├─ still insufficient? → focused evidence query (CLI-keyword rewrite)
  │                         └─ deterministic fallback
  └─ still insufficient? → surface explicit message + suggest kb query / kb submit
```

Recovery is deterministic: `looksLikeInsufficientEvidenceAnswer()` matches against a known set of LLM hedge phrases. No second LLM call is used for the recovery decision.

Conversation history is limited to 4 turns to keep context bounded.

---

## Part 3: Choosing a Loop Pattern

| Situation                                                              | Use                         |
|------------------------------------------------------------------------|-----------------------------|
| LLM decides which tools to call (autonomous agent)                     | `agentLoop`                 |
| Fixed sequence of LLM passes with known inputs/outputs                 | Cycle loop (like `kb init`) |
| User interaction between LLM calls (interview, confirmation)           | Cycle loop                  |
| Streaming output to terminal or UI                                     | `agentLoop` (events)        |
| Single LLM call, no tools                                              | `provider.call()` directly  |
| Retrieval + answer with fallback strategy                              | `kb chat` pattern           |

---

## Part 4: Implementing a New Cycle Loop

1. **Define your cycles** as a union type:
   ```typescript
   type MyCycle = 'read' | 'draft' | 'review' | 'write'
   ```

2. **Define a checkpoint interface** with `version`, `completedCycles`, and per-cycle data:
   ```typescript
   interface MyCheckpoint {
     version: 2
     updatedAt: string
     completedCycles: MyCycle[]
     // ... per-cycle data
   }
   ```

3. **Persist before advancing** — write the checkpoint after each cycle completes so it can be resumed.

4. **Skip completed cycles** — check `completedCycles.includes(cycle)` before running each block.

5. **Throw a PausedError** instead of returning when pausing mid-run. Catch it in the outer function and return `status: 'paused'`.

6. **Support `--stop-after`** — after each cycle, check `options.stopAfter === cycle` and throw PausedError if set.

7. **Use a progress reporter** — log `[${bar}] N/total label` to stderr so the user can see where execution is.

---

## Part 5: Review Checklist

### For `agentLoop` usage
- [ ] Tool definitions are registered in `ToolExecutor` before the loop starts
- [ ] `maxTurns` is set to a safe ceiling (default 10)
- [ ] All event types are handled in the consumer (`text`, `tool_result`, `done`)
- [ ] `isError: true` tool results are surfaced, not silently dropped
- [ ] Loop exit reason (`no_tool_calls` vs `max_turns_reached`) is logged or returned

### For cycle loops
- [ ] Each cycle is idempotent given the same inputs
- [ ] Checkpoint is written before advancing to the next cycle
- [ ] `completedCycles` guard prevents re-running finished cycles
- [ ] `--dry-run` skips writes but runs all passes
- [ ] `--non-interactive` skips all `stdin` calls
- [ ] `--detach` / `--resume` are supported if the loop involves user input
- [ ] LLM temperature decreases as passes progress (creative → deterministic)
- [ ] JSON parsing has a fallback so a malformed LLM response doesn't crash the whole run

---

## See Also

- `src/core/agent-loop.ts` — core loop implementation
- `src/cli/init-cli.ts` — reference cycle loop (`kb init`)
- `src/cli/chat-cli.ts` — retrieval loop with recovery strategies
- `src/cli/publish-cli.ts` — another cycle loop (`kb publish`)
- `src/tools/TOOL_CONVENTIONS.md` — tool design patterns referenced by the agent loop
- `src/core/types.ts` — `AgentEvent`, `Message`, `LLMProvider` types
