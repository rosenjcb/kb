---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I investigate by asking the kb MCP tool (kb_query) a real
  natural-language question — then verify against the returned sources — before
  grepping or reading the repo blind?
---

# KB dev workflow (agent skill)

## MCP connection → `kb_query` for discovery

This session has a **kb MCP** connection. Use **`kb_query`** to discover how the
codebase works: ask a real question, get an answer plus compact source citations
(`path (symbol)`), then verify by opening those files.

KB is not a keyword box. Ask like a teammate. Use follow-up questions to dig —
not repo-wide fishing first.

## How to ask

One string `q`: a full natural-language question (intent + entities + what you
need to decide).

**Good:**

- "Where does kb-server resolve which base to serve for an HTTP request?"
- "How does the eval harness share one multi-base server across suites?"
- "Which modules own fact curation after retrieval, and what do they drop?"

**Bad (keyword salad):**

- "base registry X-KB-Base"
- "eval-run server port"
- "curator keep drop"
- bare symbols with no question

Thin answer → ask a **narrower** follow-up. Do not switch to broad grep yet.

## How to use the response

| Part | Use it to… |
|------|------------|
| Synthesized **answer** | Working hypothesis / plan |
| **sources[]** citations (`path (symbol)`) | Open *only* these files next |
| **notes[]** | Verify hints — act on them before relying on the answer |
| **AGENT_INSTRUCTION** (rare, sampled) | A required follow-up: resolve it via `submit_feedback`, don't just read it |

`notes` may warn that confidence is mid/low or that the prose named a file not
in the sources — when it does, trust `sources` over prose paths. `AGENT_INSTRUCTION`
is a separate, unmissable field — never buried inside `notes` — and means this
specific response is queued as feedback-pending; do not skip it. Pass
`verbose: true` only if you genuinely need the raw evidence payload (per-fact
snippets, tags, retrieval metadata); the default response is the signal.

Loop: ask → read cited paths → confirm or correct → ask again for gaps → only
then minimal grep/read outside citations.

At the end of the task — once the work is validated (tests pass, change pushed)
— call **`get_feedback_requests`** to see which of your queries are still
pending, then resolve each with its own **`submit_feedback`** call: `helped`
(`yes`/`partial`/`no`), what the answer got right or missed in `notes`, and its
`requestId` — one `requestId` per call, no batching several into one. If
nothing is pending, a single general `submit_feedback` call (no `requestId`) is
still welcome. Do this when an `AGENT_INSTRUCTION` or an end-of-session
reminder asks, and judge the answers by how they held up, not by first
impression.

## When

On every coding task, before broad exploration:

```
ALWAYS: kb_query with a real question first
THEN:   open cited sources and verify
THEN:   follow-up questions for remaining gaps
ONLY THEN: minimal grep/read outside citations
```

If `kb_query` is missing, say so and ask the user to fix the kb MCP connection
in this session. Do not pretend you queried KB.
