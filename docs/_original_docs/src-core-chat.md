---
layout: default
title: src/core/CHAT.md
date: '2026-05-25'
kb_id: src-core-chat-md
tags:
  - original-source
  - src-core-chat-md
  - kb
categories:
  - reference
---

# Chat session — design

This doc is the **source of truth** for how the interactive chat session works.
Update it when behavior changes.

## How a chat turn works

```
user input
   │
   ├─ synthesis keyword? (SYNTHESIS_QUERY_RE, len ≥ 40)
   │     └─ decomposeQueryForRetrieval() → 1–4 sub-queries
   │           └─ Promise.all pre-retrievals → inject as synthetic tool turns
   │
   └─ agentic loop (while true, cap MAX_CHAT_TURNS = 12)
         LLM call with query_kb tool
            ├─ stopReason = end_turn → answer done
            └─ stopReason = tool_use
                  └─ Promise.all all tool calls concurrently
                        each: graph expand → executeChatQueryTruthRetrieval()
                        weak_evidence? → append retry hint to tool result
```

1. **Decompose pre-step** — for synthesis/elaboration queries (≥40 chars matching
   `SYNTHESIS_QUERY_RE`), a lightweight LLM call (`chat-decompose-system.md`) splits the
   query into 2–4 targeted sub-queries. All run in parallel via `Promise.all` and are
   injected as a synthetic assistant+user message pair before the main loop, giving the LLM
   grounded context from multiple angles before it starts reasoning.

2. **Agentic while loop** — replaces the old fixed `MAX_CHAT_TOOL_ROUNDS`. Runs until the
   LLM returns no `tool_use` blocks OR `MAX_CHAT_TURNS` (12) is hit. Each round calls the
   LLM with the `query_kb` tool. All tool calls in a batch execute concurrently.

3. **Graph expansion** — before each retrieval, `expandQueryWithGraph` may widen the query
   string using the concept graph.

4. **Retrieval** — `executeChatQueryTruthRetrieval()` → `runQueryTruthRetrieval()` →
   `runIntentLoop` → router → `read_facts` → `FactsQueryResearchOrchestrator` (up to 24
   passes, plateau/frontier-based early exit). Facts already in the session pool are
   excluded via `excludeIds`.

5. **LLM context** — every fact in the ranked retrieval `results[]` is passed to the model
   with **full `fact_text`** via `formatRetrievedFactsForLLM()` (`src/core/retrieval-context.ts`).
   No snippet extraction, no char caps.

6. **Evidence header** — one `evidence>` summary line (count, mix, themes, leads, walk/stop/conf).
   See `src/core/EVIDENCE_SUMMARY.md`. Per-fact bullet previews removed.

7. **Weak evidence signal** — when retrieval stops with `weak_evidence_after_exhaustion`,
   `buildToolQueryResult` appends a note telling the LLM to try different query terms before
   concluding information is unavailable.

8. **Orchestration footer** — `printReadDocumentsOrchestrationFooter()` prints `retrieval>`,
   `matches>`, `sources>`, `timing>`. Use `--verbose` for `summary>`/`confidence>` rows,
   `--debug` for per-document provenance.

## Prompts

| File | Role |
|------|------|
| `chat-router-system.md` | Main system prompt — when to call `query_kb`, multi-angle policy, weak-evidence retry rule |
| `chat-decompose-system.md` | Decompose call — outputs 1–4 retrieval sub-queries, one per line |

## Why not shell out to `kb query`?

Calling the CLI in a loop duplicates process startup, env, base resolution, and error
surfaces. The orchestrator module is the **same contract** as query without a fork/exec boundary.

## Invariants

- The while loop always breaks on `end_turn` or when tool count is 0; `MAX_CHAT_TURNS` is a safety cap only.
- All tool calls in a single LLM round execute concurrently — never sequentially.
- `buildToolQueryResult` always appends the weak-evidence hint when `weak_evidence_after_exhaustion` is in the retrieval detail.
- Decompose only fires when `SYNTHESIS_QUERY_RE` matches AND input is ≥40 chars.

## See also

- `src/cli/chat-query-orchestrator.ts` — builds chat `query_truth` envelope
- `src/cli/query-truth-retrieval.ts` — shared retrieval for both `kb query` and chat
- `src/tools/facts-query-research-orchestrator.ts` — deep retrieval loop (24-pass max)
- `src/core/QUERY_INTERNALS.md` — retrieval internals
- `src/core/TUI.md` — TUI command surface
