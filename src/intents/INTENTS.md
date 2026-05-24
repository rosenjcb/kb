# Intent Routing

Maps **consumer intent envelopes** (`query_truth`) to **tool operations** executed by the agent loop. CLI and chat both build envelopes; routing stays in this package so policy does not scatter across commands.

## Core types

- `ConsumerIntentEnvelope` — `intent` + `payload` (+ session metadata from CLI parsers)
- `RouteDecision` — `selectedOperation`, `operationInput`, `policyReason`
- `IntentResult` — tool output surfaced back to CLI/TUI formatters

Defined in `types.ts`; evaluated in `evaluator.ts` for guardrails.

## `DefaultIntentRouter`

`router.ts` is the production router:

| Intent | Operation | Notes |
|---|---|---|
| `query_truth` | `read_facts` | Sets `limit`, `discoveryDepth`, `surface`; high-recall queries bump limit |

`execute()` dispatches to the tool registry for `read_facts`.

## Relationship to `runIntentLoop`

`src/core/intent-loop.ts` calls `router.route()` then `router.execute()` (or equivalent tool path). **`runQueryTruthRetrieval`** (`src/cli/query-truth-retrieval.ts`) is the only supported entry for `query_truth` from CLI/chat — keeps discovery depth and limit escalation consistent.

Do not add a second retrieval path that bypasses the router for `read_facts`.

## Policy hooks

`policy.ts` holds cross-cutting rules. When adding intents:

1. Extend `ConsumerIntentEnvelope` intent union in `types.ts`
2. Add `route()` case with explicit `policyReason`
3. Wire `execute()` branch or new orchestrator
4. Add CLI parser in `intent-cli.ts` (and chat envelope builder if user-facing)

## High-recall queries

`requiresHighRecallQuery()` in `router.ts` detects broad questions and raises `read_facts` limit (min 12). Changing recall behavior affects both `kb query` and chat — test both surfaces.
