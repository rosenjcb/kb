# Chat Architecture

## What `kb chat` Does Today

`kb chat` is a conversational loop that issues one `read_documents` call per turn and streams
a synthesized answer back to the user. Each turn:

1. The user's message is optionally rewritten into a standalone retrieval query (session-aware
   rewrite via `src/cli/chat-cli.ts`).
2. That query is routed through the intent pipeline (`query_truth` intent →
   `DefaultIntentRouter` → `read_documents` tool).
3. `read_documents` calls `MarkdownDocumentReader.queryDocuments()` with `discoveryDepth:
   'shallow'` (the default).
4. The resulting documents are passed to an LLM to generate a conversational reply.

`kb chat` is therefore a thin interface around the same retrieval stack that `kb query` uses.
It adds session context (previous turns rewrite follow-up messages into standalone queries) but
does not decide *which* intent to invoke — it always queries.

## The Future: Chat as an Agent Harness

The intended direction is for `kb chat` to become its own agent harness: a loop that *decides*
which intent function to call based on the incoming message, then executes it and returns the
result conversationally.

The intent functions that could be dispatched:

| Intent | Trigger | Effect |
|--------|---------|--------|
| `query` (`read_documents`) | Factual or exploratory question | Returns relevant docs; answers with evidence |
| `submit` (`write_document`) | "Remember that X", "Record that Y" | Persists new or updated KB doc |
| `invalidate` | "That's no longer true", "Remove X" | Removes or replaces a fact |
| `validate` | "Is X still accurate?" | Scores an existing doc against current knowledge |
| `explain` | "What does this doc mean?", "Explain X" | Deep-reads a single doc and paraphrases it |

The harness would work like this:

```
User message
  → intent classifier  (lightweight LLM call: query / submit / invalidate / validate / explain)
  → dispatch to intent handler
  → intent handler runs (may call read_documents with deep discovery, or write_document, etc.)
  → synthesize conversational reply from handler output
  → append to session context
```

Key design principles for the future harness:

- **One owner per turn.** The classifier decides intent once; the handler executes. No blending.
- **Narrow workers.** Each intent handler (query, submit, etc.) only does its one thing. The
  harness does not let a worker also classify or route.
- **Discovery depth from intent.** Exploratory questions (`query`) should pass `discoveryDepth:
  'deep'` to use the research orchestrator. Quick lookups use `'shallow'`.
- **Session context flows forward.** The harness accumulates turn history so each new message
  can be rewritten into a standalone intent before dispatch.

## Research Orchestrator and Chat

`QueryResearchOrchestrator` (see `src/tools/query-research-orchestrator.ts`) is activated by
`discoveryDepth: 'deep'`. Once the chat harness lands, the classifier should set `deep` for
multi-step, exploratory, or ambiguous questions — i.e., most non-trivial chat turns.

The shallow path (current default) remains the right choice for quick follow-ups, clarifications,
or when the user is asking about a specific doc they already know about.

## See Also

- `src/core/TUI.md` — command surface and interaction contract
- `src/tools/query-research-orchestrator.ts` — deep discovery research loop
- `src/tools/markdown-document-reader.ts` — shallow retrieval pipeline
- `src/core/AGENT_LOOP.md` — intent loop, retry, and subagent harness
- `src/core/ORCHESTRATOR.md` — multi-pass init orchestration (different concern)
