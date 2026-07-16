---
type: "Design Doc"
title: "Chat Session Design"
description: "The source-of-truth design for how the interactive KB chat session and its turn lifecycle work."
resource: ./src/core
tags: [chat, tui, retrieval]
timestamp: 2026-06-21T00:00:00Z
---

# Chat session — design

This doc is the **source of truth** for how the interactive chat session works.
Update it when behavior changes.

**Mental model:** chat is currently *a series of KB queries with user input between
turns*. Each user message drives one or more `query_kb` retrievals over the **same**
`query_truth` path as `kb query` — including the post-retrieval **fact curator**. The only
thing that persists across turns is the prior question/answer **prose** in `messages[]`;
there is **no** persistent cross-turn fact pool. Relevance is therefore re-decided per query
by the curator, not carried forward and re-filtered.

## How a chat turn works

```mermaid
flowchart TD
  U([user input]) --> S{"synthesis query?<br/>SYNTHESIS_QUERY_RE, ≥40 chars"}
  S -- yes --> D["decomposeQueryForRetrieval()<br/>1–4 sub-queries"]
  D --> PR["Promise.all pre-retrievals<br/>injected as synthetic tool turns"]
  PR --> L
  S -- no --> L["agentic loop<br/>while true, ≤ MAX_CHAT_TURNS (12)"]
  L --> LLM["LLM call w/ query_kb tool"]
  LLM -- end_turn --> A([answer done])
  LLM -- tool_use --> T["Promise.all tool calls (concurrent)"]
  T --> GE["graph expand →<br/>executeChatQueryTruthRetrieval()"]
  GE -- weak_evidence --> RH["append retry hint"] --> L
  GE -- ok --> L
```

1. **Decompose pre-step** — for synthesis/elaboration queries (≥40 chars matching
   `SYNTHESIS_QUERY_RE`), a lightweight LLM call (`chat-decompose-system.md`) splits the
   query into 2–4 targeted sub-queries. The user message includes a **retrieval checklist**
   for the inferred answer type (`src/query/RETRIEVAL_CHECKLISTS.md`) so sub-queries cover
   howto/reference/decision/runbook dimensions when relevant. All run in parallel via
   `Promise.all` and are injected as a synthetic assistant+user message pair before the main
   loop, giving the LLM grounded context from multiple angles before it starts reasoning.

2. **Agentic while loop** — replaces the old fixed `MAX_CHAT_TOOL_ROUNDS`. Runs until the
   LLM returns no `tool_use` blocks OR `MAX_CHAT_TURNS` (12) is hit. Each round calls the
   LLM with the `query_kb` tool. All tool calls in a batch execute concurrently.

3. **Graph expansion** — before each retrieval, `expandQueryWithGraph` may widen the query string.

4. **Retrieval** — `executeChatQueryTruthRetrieval()` → `runQueryTruthRetrieval()` →
   `runIntentLoop` → router → `read_facts` → `FactsQueryResearchOrchestrator` (up to 24
   passes, plateau/frontier-based early exit). Each retrieval is independent — facts are not
   carried over from prior turns (`query_truth` still accepts an optional `excludeIds`, but the
   chat path does not populate it).

5. **Curation** — when the pool exceeds 12 facts, the **fact curator**
   (`src/tools/fact-curator.ts`) judges it against the user's question, hard-drops off-topic
   facts, and runs bounded re-discovery to refill gaps. Decisions are recorded out-of-band on
   `retrieval.curation` — never added to the prompt. See `src/tools/FACT_CURATOR.md`.

6. **LLM context** — surviving `results[]` via `formatRetrievedFactsForLLM()`
   (`src/core/retrieval-context.ts`), 2000 chars per fact.

7. **Answer synthesis** — chat uses **`runChatSynthesis()`** (`chat-cli.ts`): multi-turn loop
   with optional `query_kb` tool calls. This is **not** the `kb query` path — CLI query uses
   one-shot `enrichReadDocumentsAnswerWithLLM()` instead (see `QUERY_INTERNALS.md`).

8. **Evidence header** — one `evidence>` summary line (count, mix, themes, leads, walk/stop/conf).
   See `src/core/EVIDENCE_SUMMARY.md`.

9. **Weak evidence signal** — when retrieval stops with `weak_evidence_after_exhaustion`,
   `buildToolQueryResult` appends a note telling the LLM to try different query terms before
   concluding information is unavailable.

10. **Orchestration footer** — `printReadDocumentsOrchestrationFooter()` prints `retrieval>`,
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
- No fact pool persists across turns; each turn's retrieval is independent and the curator re-decides relevance per query.
- Curator decisions are recorded out-of-band on `retrieval.curation` and never injected into the synthesis prompt.

## See also

- `src/cli/chat-query-orchestrator.ts` — builds chat `query_truth` envelope
- `src/cli/query-truth-retrieval.ts` — shared retrieval for both `kb query` and chat
- `src/tools/facts-query-research-orchestrator.ts` — deep retrieval loop (24-pass max)
- `src/core/QUERY_INTERNALS.md` — retrieval internals
- `src/core/TUI.md` — TUI command surface
