---
name: kb:dev-workflow
description: >-
  Is the user giving me a coding task in a project that uses the KB knowledge
  store? Should I investigate by asking the kb MCP tool (query) a real
  natural-language question — then verify against the returned sources — before
  grepping or reading the repo blind?
---

# KB dev workflow (agent skill)

## MCP connection → `query` for discovery

This session has a **kb MCP** connection. Use **`query`** to discover how the
codebase works: ask a real question, get an answer plus lean source citations
(`{ path, symbols? }`), then verify by opening those files.

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
| **sources[]** citations (`{ path, symbols? }`) | Open *only* these files next |
| **notes[]** | Verify hints — act on them before relying on the answer |
| **answerError** | The answer step *failed*. Do **not** read `answer: null` as "the KB has nothing" — retry, or report the outage |
| **AGENT_INSTRUCTION** (rare, sampled) | Required follow-up: resolve via `submit_feedback` (one string `requestId`, not an array) |
| **feedback** (rare, sampled, elicitation) | Already recorded (or declined) via a user form — no further submit needed |

`notes` may warn that confidence is mid/low or that the prose named a file not
in the sources — when it does, trust `sources` over prose paths.

When **`answerError`** is present, retrieval succeeded and only synthesis failed —
the `sources` are real and worth opening, but the missing answer says nothing about
what the knowledge base contains. `retryable: true` (rate limit, 5xx, timeout,
empty response) means try again; `insufficient_credits` or `auth` needs a human to
fix billing or the API key, so surface it rather than retrying. `retrieval.degraded[]`
is the softer version: an answer came back, but a ranking or filtering stage was
skipped after an LLM error, so weigh the ordering less. Feedback asks
are still gated by `KB_FEEDBACK_SAMPLE_RATE` (default off). Form elicitation is
on by default (`KB_MCP_ELICITATION=false` to disable): the user may answer
yes/partial/no in a UI and the payload carries `feedback.via=elicitation`
instead of `AGENT_INSTRUCTION`. Otherwise `AGENT_INSTRUCTION` is a separate,
unmissable field — never buried inside `notes` — and means this response is
queued as feedback-pending; do not skip it. Pass `verbose: true` only if you
genuinely need the raw evidence payload (per-fact snippets, tags, retrieval
metadata); the default response is the signal.

Loop: ask → read cited paths → confirm or correct → ask again for gaps → only
then minimal grep/read outside citations.

At the end of the task — once the work is validated (tests pass, change pushed)
— call **`get_feedback_requests`** to see which of your queries are still
pending, then resolve each with its own **`submit_feedback`** call: `helped`
(`yes`/`partial`/`no`), what the answer got right or missed in `notes`, and its
`requestId` — one string `requestId` per call, never a `requestIds` array. If
nothing is pending, a single general `submit_feedback` call (no `requestId`) is
still welcome. Do this when an `AGENT_INSTRUCTION` or an end-of-session
reminder asks, and judge the answers by how they held up, not by first
impression.

## When

On every coding task, before broad exploration:

```
ALWAYS: query with a real question first
THEN:   open cited sources and verify
THEN:   follow-up questions for remaining gaps
ONLY THEN: minimal grep/read outside citations
```

If `query` is missing, say so and ask the user to fix the kb MCP connection
in this session. Do not pretend you queried KB.
