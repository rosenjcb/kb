# Implement kb chat interactive REPL command

## Ticket ID
068

## Theme
local-kb

## Problem
Ticket 067 defined `kb chat` semantics, but no interactive runtime loop exists in the CLI.

## Scope
- Add `kb chat` command entrypoint and interactive REPL loop.
- Wire per-turn retrieval grounding and LLM response generation.
- Support graceful exit and interrupt handling.

## Acceptance Criteria
- `kb chat` starts an interactive session and supports multi-turn chat.
- Each assistant reply is grounded by retrieval evidence flow.
- Exit handling is stable (`/exit`, Ctrl+C).

## Dependencies
067
065

## Deliverables
- CLI runtime implementation for `kb chat`.
- Focused runtime tests for command loop behavior.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Initial kb chat Prototype (Evidence-Grounded, Prompt/System Loop)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Prototype command semantics for `kb chat`
	- Prompt/system loop with per-turn KB evidence retrieval
	- Minimal slash-command set and output contract
- ✅ Phase 2 (Implementation): In scope for this ticket
	- Build initial REPL command loop
	- Build per-turn retrieval + LLM response flow
	- Show evidence/provenance and retrieval mode in output
- ⏳ Deferred
	- Extended session controls/transcript persistence (ticket 069)
	- Context-rot hardening and long-session guardrails (ticket 070)

#### Background
Ticket 067 selected Option 1 (prompt/system-driven chat loop) with explicit user approval to defer context-rot hardening. This ticket delivers the first usable `kb chat` prototype so users can converse with KB-backed evidence immediately.

#### Approach
Implement `kb chat` as an interactive terminal loop. Each user turn will run KB retrieval first (`read_documents`, semantic-capable path), then call the configured LLM with a system prompt plus evidence snippets and bounded recent turns. The assistant response is printed with retrieval metadata (`method`/`detail`) and top provenance IDs so users can trust and inspect grounding.

#### Examples / Specifications

Prototype command contract:

```text
kb chat

assistant> Chat mode started. Type /help for commands.
you> how does vector retrieval work in this kb?
assistant> [LLM answer grounded in retrieved evidence]
retrieval> hybrid (fts+vector-rerank)
sources> session-log-2026-04-12, general-facts
```

Prototype commands (v1):
- `/help` show commands
- `/exit` exit session

Turn pipeline:

```text
user input
	-> read_documents(query=<user text>, mode=content/auto, includeContent=true, limit=5)
	-> build prompt: [system + evidence snippets + short recent turns + current turn]
	-> llmProvider.call(...)
	-> print assistant answer + retrieval mode/detail + provenance ids
```

#### Error Conditions / Edge Cases
- Provider unavailable: print actionable error and keep REPL alive for retry.
- No KB evidence found: instruct model to answer with uncertainty and suggest next query.
- Retrieval fallback triggered: still answer, but print `retrieval> lexical-fallback (...)`.
- Empty input: ignore without breaking loop.

#### Decisions Made
- ✅ Decided: Prototype prioritizes shipping conversational utility quickly. -> Rationale: user requested initial prototype first.
- ✅ Decided: Evidence and retrieval mode are included from day one. -> Rationale: transparency and trust for grounded answers.
- ✅ Decided: Advanced controls/context-rot deferred to follow-up tickets. -> Rationale: reduce initial complexity and delivery risk.

#### User Decision Checkpoint
- Decision requested from user: Architecture and delivery strategy for first version.
- User response: Option 1 prompt/system-driven loop, ship initial prototype now, handle context-rot later.
- Follow-up: Ticket 069 for controls/transcripts, ticket 070 for context-rot mitigation.

#### Integration Points
- Depends on ticket 065 retrieval behavior (hybrid + fallback + retrieval metadata).
- Reuses existing provider wiring and intent tooling surfaces.
- Feeds transcript and controls roadmap in ticket 069.

#### Validation & Closure
This implementation plan establishes:
- ✅ Prototype command semantics are explicit.
- ✅ Retrieval + LLM orchestration is explicit.
- ✅ Deferred reliability work is linked to explicit follow-up tickets.

Ticket 068 remains open for implementation in this branch.

---

## Implementation Notes

### Completed in This Ticket
- Added `kb chat` interactive command path in the CLI entrypoint.
- Added a dedicated chat runtime loop module with:
	- Per-turn `read_documents` retrieval (`mode=content`, `includeContent=true`, bounded limit)
	- LLM answer call with grounded evidence prompt construction
	- Output of retrieval mode/detail and source document IDs each turn
	- Stable exit behavior for `/exit` and Ctrl+C
- Hardened shared retrieval behavior used by all `read_documents` consumers:
	- lexical scoring/ranking across full candidate set (instead of early first-match cutoff)
	- keyword broadening retry path for content/auto misses
- Added pragmatic chat fallback for broad project-overview questions:
	- when retrieval is empty or ticket-only, supplement evidence with workspace docs (`README.md`, `GAMEPLAN.md`)
	- mark retrieval detail with `workspace-fallback` for transparency
- Added focused CLI chat tests for:
	- command loop control (`/help`, `/exit`)
	- retrieval + answer turn behavior
	- provider failure resilience
	- workspace fallback evidence behavior

### Validation Evidence
- `runTests` (focused): `tests/cli/chat-cli.test.ts` and `tests/cli/intent-cli.test.ts` passed.
- `npm run type-check` passed.
- Runtime smoke: `printf '/exit\\n' | npm run dev -- chat` starts and exits cleanly.

### Follow-ups (Deferred by Decision)
- Ticket 069: session controls and transcript persistence.
- Ticket 070: context-rot hardening and long-session safeguards.
