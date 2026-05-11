# Chat session — design

This doc is the **source of truth** for how the interactive session relates to `kb query` today.
Update it when behavior changes.

## How a chat turn works

1. **Resolve the turn** — conversational mode may rewrite follow-ups into a standalone retrieval
   query (`src/cli/chat-conversation.ts`).
2. **Graph expansion** — same helpers as CLI query (`expandQueryWithGraph`, relation block for the LLM prompt).
3. **Run initial retrieval** — calls **`executeChatQueryTruthRetrieval()`** in
   `src/cli/chat-query-orchestrator.ts`, which delegates to **`runQueryTruthRetrieval()`**:
   `runIntentLoop` → router → **`read_facts`** (fact FTS + deep **`FactsQueryResearchOrchestrator`**).
   Facts already in the session pool are excluded via `excludeIds`. **No** workspace markdown fallback.
4. **Agentic answer loop** — the LLM is given a `query` tool it can call to fetch additional facts
   mid-answer (up to 3 rounds). Each `query` call runs another retrieval pass and injects results as
   tool-result messages so the LLM can continue. New facts accumulate into the session pool.
5. **Conversational answer** — final LLM reply from step 4 is printed.
6. **Orchestration footer** — `printReadDocumentsOrchestrationFooter()` prints `retrieval>`,
   `matches>`, `sources>`. Add **`chat --verbose`** in the TUI shell before the session starts to
   also see `summary>`, `status>`, and `confidence>` rows. Add **`chat --debug`** for full
   per-document provenance lines.

**`query-session.json`:** only when **`kb query --session`** (not the chat session).

## Why not shell out to `kb query`?

Calling the CLI in a loop would duplicate process startup, env, base resolution, and error
surfaces. The orchestrator module is the **same contract** as query without a fork/exec boundary.

## See also

- `src/cli/query-truth-retrieval.ts` — shared retrieval for both `kb query` and the chat session
- `src/cli/chat-query-orchestrator.ts` — builds chat `query_truth` envelope, delegates to shared retrieval
- `src/cli/intent-cli.ts` — `printReadDocumentsOrchestrationFooter`, augment helpers
- `src/intents/router.ts` — `query_truth` → `read_facts` routing
- `src/core/TUI.md` — TUI command surface
