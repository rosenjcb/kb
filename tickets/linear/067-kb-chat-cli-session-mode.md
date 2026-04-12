# Add kb chat interactive CLI session mode

## Ticket ID
067

## Theme
local-kb

## Problem
Current `kb` usage is primarily one-shot (`kb query`, `kb explain`, freeform single prompts). There is no first-class interactive chat session mode for back-and-forth exploration of KB context.

## Scope
- Define a `kb chat` command for interactive terminal conversation.
- Specify session behavior for multi-turn context and message history.
- Define retrieval + answer orchestration model (hybrid retrieval as evidence, LLM synthesis for replies).
- Compare architecture options:
  - Prompt/system-driven conversational loop
  - One-shot complete-per-turn with reconstructed context
  - Hybrid approach (recommended candidate)
- Define exit controls, command shortcuts, and transcript persistence behavior.

## Acceptance Criteria
- A clear and reviewable markdown spec exists.
- Interactive command semantics are unambiguous (`kb chat`, exit/help/reset behavior).
- Session memory model and context-window strategy are explicit.
- Retrieval and LLM response pipeline is explicit (including fallback behavior).
- Open architecture decisions are listed with recommended default.

## Dependencies
057
058
059
063
065

## Deliverables
- Final markdown spec in this file.
- Architecture decision section comparing chat-loop designs.
- Handoff notes for implementation and test planning.

## Estimate
M

## Priority
High

---

## Implementation Plan

### kb chat Session Mode — Option 1 (Prompt/System-Driven Chat Loop)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
  - Interactive command semantics for `kb chat`
  - Session loop design using system/prompt chat-driven API
  - Retrieval + response orchestration
  - User decision captured and recorded
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
  - Implement `kb chat` runtime and REPL loop
  - Add slash-command/session controls
  - Add tests + rollout documentation
  - **Blocking tickets**: 068, 069, 070

#### Background
Users want a first-class conversational interface over KB data. Existing one-shot intent commands are strong for discrete actions but not ideal for continuous back-and-forth exploration.

#### Approach
Adopt Option 1 for v1: a prompt/system-driven chat loop where each turn uses a stable system prompt, conversational history, and KB retrieval evidence to produce the next response. Retrieval remains explicit in the loop (`read_documents` evidence grounding), but the response layer is fully conversational and LLM-driven. Session remains interactive until exit command, with transcript persisted for continuity.

#### Examples / Specifications

CLI contract:

```text
kb chat

> user: how does vector retrieval work here?
assistant: ...

/help     show commands
/reset    clear in-memory conversation state for current session
/save     flush transcript checkpoint to session file
/exit     end chat session
```

Turn pipeline (Option 1):

```text
user turn
  -> retrieve evidence (read_documents, mode=content/auto)
  -> compose messages: [system prompt + bounded history + evidence snippets + user turn]
  -> LLM completion
  -> render assistant response
  -> append turn to session transcript
```

Persistence shape (v1):
- Session transcript file under `sessions/chat/` (or namespaced equivalent)
- Rolling window in memory; full transcript on disk

#### Error Conditions / Edge Cases
- LLM/provider unavailable: return clear error + keep session alive for retry.
- Retrieval no-match: assistant must answer with uncertainty and suggest a follow-up query.
- Oversized context window: trim oldest conversational turns first, preserve latest retrieval snippets.
- Keyboard interrupt (`Ctrl+C`): graceful exit with optional autosave.

#### Decisions Made
- ✅ Decided: Use Option 1 (prompt/system-driven chat loop) for v1. -> Rationale: fastest path to conversational UX with minimal CLI surface change.
- ✅ Decided: Keep retrieval grounding in each turn. -> Rationale: reduces hallucination and aligns with KB-first intent.
- ❓ Open question (deferred by user): context-rot mitigation strategy beyond bounded trimming. -> Time-box: revisit after initial adoption telemetry in ticket 070.

#### User Decision Checkpoint (Required)
- Decision requested from user: Choose architecture for `kb chat` v1.
- Options presented:
  - 1) Prompt/system-driven chat loop
  - 2) One-shot complete-per-turn reconstruction
  - 3) Hybrid
- User response: **Option 1**, with explicit approval to defer context-rot hardening for now.
- Follow-up: Created tickets 068, 069, 070 for implementation and validation.

#### Integration Points
- Integrates with existing intent/read pipeline (`read_documents`) and provider selection in CLI runtime.
- Reuses base selection (`kb use`/`kb default`) so chat sessions stay namespace-consistent.
- Must preserve dogfood checkpointing expectations for significant conversational outcomes.

#### Validation & Closure
This implementation plan establishes:
- ✅ Interactive `kb chat` behavior is specified and reviewable.
- ✅ Retrieval + LLM orchestration is explicit.
- ✅ User architecture decision is captured.
- ✅ Deferred concerns are documented with follow-up tickets.

**Ticket 067 is now closed.**
