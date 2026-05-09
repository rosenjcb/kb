---
layout: default
title: src/core/CHAT.md
date: '2026-05-09'
kb_id: src-core-chat-md
tags:
  - original-source
  - src-core-chat-md
  - kb
categories:
  - reference
---

# Chat (`kb chat`) — design and roadmap

This doc is the **source of truth** for how chat relates to `kb query` today and how we expect it
to grow. Update it when behavior changes.

## Today: one dumb orchestrator, one “tool”

Chat is intentionally minimal:

1. **Resolve the turn** — conversational mode may rewrite follow-ups into a standalone retrieval
   query (`src/cli/chat-conversation.ts`).
2. **Graph expansion** — same helpers as CLI query (`expandQueryWithGraph`, relation block for the LLM prompt).
3. **Run retrieval exactly like `kb query`** — both call **`runQueryTruthRetrieval()`** in
   `src/cli/query-truth-retrieval.ts`: `runIntentLoop` (same **`query_truth`** envelope the CLI
   builds after graph expansion and **only** optional **`--session`** rewrite — default
   CLI query uses the literal topic string, like chat) → router → **`read_facts`** (fact FTS +
   deep **`FactsQueryResearchOrchestrator`** when discovery is deep). **No** workspace markdown
   fallback. `DefaultIntentRouter` defaults **`query_truth`** to **`discoveryDepth: 'deep'`** when
   `--discovery` is omitted, so chat and CLI get the same research-style retrieval; chat passes
   **`discoveryDepth: 'deep'`** explicitly plus the chat retrieval limit.
4. **Conversational answer** — evidence from step 3 is passed to the chat system prompt + LLM
   (`src/cli/chat-cli.ts`, `src/prompts/chat-system.md`).
5. **Orchestration output** — `printReadDocumentsOrchestrationFooter()` prints the same minimal
   wire rows as `kb query` human mode: `retrieval>`, `matches>`, then a single **`sources>`** line
   with all hit **titles** (ids as fallback). With **`--debug`** / **`chat --debug`**, it instead
   prints one full provenance **`source>`** line per document (same shape as legacy query output).
   **`summary>`**, **`status>`**, and **`confidence>`** are only included when the user passed
   **`--verbose`** on **`kb chat`** (CLI) or **`chat --verbose`** in the TUI shell *before* the
   session starts; there is no mid-session toggle. Router fields like `explanation` / `provenance`
   stay on `IntentResult` for JSON and telemetry but are not duplicated in the human footer by
   default.

**`query-session.json`:** only when **`kb query --session`** (not chat).

So today’s “orchestrator” is **trivial**: always call **`runQueryTruthRetrieval()`** (not a second
router shortcut), then the LLM, then the shared footer. Subprocess `kb query` is **not** spawned;
in-process reuse keeps config, base, and telemetry aligned.

## Why not shell out to `kb query`?

Calling the CLI in a loop would duplicate process startup, env, base resolution, and error
surfaces. The orchestrator module is the **same contract** as query without a fork/exec boundary.

## Near future: richer chat orchestrator

The next step is a small **turn router** in front of the loop:

- Classify (rules + optional lightweight LLM): QUERY vs SUBMIT vs INVALIDATE vs DOCS vs GRAPH …
- **QUERY** → keep calling **`runQueryTruthRetrieval()`** (via `executeChatQueryTruthRetrieval()`’s
  thin envelope builder).
- Other intents → dispatch to the same handlers the CLI already uses, then summarize for chat.

Principles:

- **One owner per turn** — pick an intent once, run it, render with shared printers.
- **Reuse CLI intent paths** — avoid a second implementation of query/submit/invalidate for chat.
- **Orchestration lines stay wire-format** — `key> value` rows only from `Printer` / shared
  formatters so TUI and piped CLI stay consistent (`src/ui/orchestration-meta.ts`).

## Historical note

Older revisions called `read_documents` directly from chat with hand-built inputs; that drifted
from `kb query` (different limits, router `explanation` / `confidence` not shown in the default human
footer, different augment order). The orchestrator + footer alignment fixes that; use **`--verbose`**
when you want those extra human rows to match an explicit `kb query --verbose` session.

## See also

- `src/cli/query-truth-retrieval.ts` — shared **`runQueryTruthRetrieval()`** for CLI `kb query` and chat
- `src/cli/chat-query-orchestrator.ts` — builds chat **`query_truth`** envelope, delegates to shared retrieval
- `src/cli/intent-cli.ts` — `printReadDocumentsOrchestrationFooter`, augment helpers
- `src/intents/router.ts` — `query_truth` → **`read_facts`** routing
- `src/core/TUI.md` — TUI command surface
- `src/core/AGENT_LOOP.md` — full intent loop (retries, escalation); chat may adopt more of this
  later for QUERY turns
