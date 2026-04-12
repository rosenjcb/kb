---
name: spike-ticket-workflow
description: "Use when: working on KB backlog tickets; closing spike tickets; adding implementation plans to markdown tickets; building iteratively from plan → code → spec; ensuring tickets serve as source-of-truth documentation for MCP agent queries."
---

# SPIKE Ticket Workflow

## What is a SPIKE Ticket in This Project?

A **SPIKE ticket** is a self-contained task that is **closed by adding an "Implementation plan" section directly to the ticket markdown file**. Think of it like a ServiceNow ticket where a technician resolves it and leaves a detailed comment explaining the solution.

The ticket file itself becomes the **source of truth** documentation—specs, architecture sketches, decisions, error conditions, and examples are all embedded in the markdown. This means:

- Agents (Claude, future multi-agent systems) query the KB via MPC and get exactly this markdown as context.
- Humans read these files to understand project decisions and constraints.
- No separate wiki, design doc repository, or scattered decision logs.

## Ticket Lifecycle

### What Makes a Ticket "Ready"?

A ticket starts in the backlog (`/tickets/linear/`) with:

```
# Title
## Ticket ID
## Theme
## Problem
## Scope
## Acceptance Criteria
## Dependencies
## Deliverables
## Estimate
## Priority
```

### What Closes a Ticket?

Add a new section at the bottom (after `## Priority`) called `## Implementation Plan` that contains:

1. **Clear statement of what was decided/built** (1–2 sentences)
2. **Concrete architecture or data structure** (use `code blocks` or ASCII diagrams)
3. **Specific request/response shapes or examples** (if applicable)
4. **Decision rationale** (why this approach, why not alternatives)
5. **Open questions** (things to revisit; time-box them or mark as future work)
6. **Validation & Closure** (checkmark list or summary that the ticket acceptance criteria are met)

End with: **"Ticket [NUMBER] is now closed."**

Important closure gate:

- If any `❓ Open question` remains unresolved, ask the user directly before closure.
- Only close when the user has either:
   1. provided a decision, or
   2. explicitly approved deferral with a time-box/follow-up ticket.
- Prefer multiple-choice prompts when options are known:
   1. Provide 2-5 concrete options.
   2. Mark a recommended default.
   3. Accept freeform override.

## Implementation Plan Template

```markdown
---

## Implementation Plan

### [Clear Title Restating the Decision/Outcome]

#### Background
[1–2 sentences establishing the problem we're solving]

#### Approach
[What we decided to do and why; 3–5 sentences max]

#### Examples / Specifications
[Concrete code samples, JSON schemas, ASCII diagrams, or markdown examples]

#### Error Conditions / Edge Cases
[What happens when X? How do we handle Y?]

#### Decisions Made
- ✅ Decided: [key decision 1] → Rationale: [why]
- ✅ Decided: [key decision 2] → Rationale: [why]
- ❓ Open question: [thing we're punting] → Time-box: [v1.1 / future]

#### User Decision Checkpoint (Required if any open question exists)
- Decision requested from user: [question]
- Options presented: [A/B/C... with recommended default]
- User response: [decision or explicit deferral]
- Follow-up: [ticket/time-box if deferred]

#### Integration Points
[How does this connect to other tickets or systems? What's next?]

#### Validation & Closure
This implementation plan establishes:
- ✅ [Acceptance criterion 1 is satisfied]
- ✅ [Acceptance criterion 2 is satisfied]
- ✅ [Acceptance criterion 3 is satisfied]

**Ticket [NUMBER] is now closed.**

---

### Note: Handling Deprecated Content

If your implementation plan involves replacing a previous design or approach:

1. **Mark old content as DEPRECATED** with clear explanation of why
2. **Move to companion file** if section is large: `TICKET_NUMBER-DEPRECATED.md`
3. **Link to new approach**: "Old method archived in [FILE]; new approach uses [TOOL/PATTERN]"
4. **Preserve for learning**: Deprecated docs explain "why not X" and provide context for future decisions

See [Deprecation and Cleanup Policy](../../AGENTS.md#deprecation-and-cleanup-policy) for full guidelines.


## Workflow: Plan → Code → Spec → Iterate

### Phase 1: Implementation Plan (Text-First)
1. **Read the ticket** to understand acceptance criteria and dependencies.
2. **Write the plan** in the Implementation Plan section—this happens *first*, before code.
3. **Be succinct but detailed**: You're writing for agents to consume via MCP, so be precise about shapes, error handling, and decisions.
4. **Avoid pseudo-spec**: Don't write something half-way between "here's what we could do" and "here's the full spec." Instead:
   - If it's simple (e.g., OpenAPI schema), include the full schema.
   - If it's complex (e.g., multi-stage agent loop), include a sketch and highlight open questions.
   - Link to tickets that fill in the missing pieces.

### Phase 2: Code & Examples (Optional; Only if Needed)
- If the ticket asks for working code (e.g., "implement the query handler"), write the code *after* the plan.
- Small, focused code examples are OK to embed in the plan (e.g., TypeScript interfaces, test cases).
- If it's a larger implementation, create the code in `src/` and reference it in the plan: "See `src/core/kb-query.ts` for the full implementation."

### Phase 3: Spec Refinement (Iterative)
- If you uncover ambiguities while writing code, **update the Implementation Plan** to clarify.
- If you find existing code that contradicts the plan, **either update the plan or file a separate ticket** to reconcile.
- Mark open questions honestly—"We could use embeddings or BM25; we'll revisit if latency > 200ms" is more useful than "we haven't decided."

## Dogfood Requirement (Mandatory)

For this repository, all meaningful development work must be documented in the KB using the CLI as part of the workflow.

Canonical source: `AGENTS.md` contains the always-on repository policy. If there is any mismatch, follow `AGENTS.md`.

### Required Behavior

1. Before major implementation work, confirm `kb` is available.
2. If `kb` is missing or stale, refresh the global tool from the current repo.
3. During work, write/update KB docs for architecture, decisions, and outcomes.
4. Keep test data isolated from dogfood knowledge using namespaces.
5. Commit and push persistent KB docs so context survives machine loss.

### Intent-First Dogfood (Workspace Policy)

For this repository, dogfood operations should default to intent commands.

1. Prefer:
   - `kb query ...` to discover existing docs.
   - `kb submit ... --target <doc-id>` to append checkpoint updates.
2. Only create a new document when query results show no suitable existing target.
3. Use freeform (`kb "..."`) only when:
   - user explicitly requests freeform, or
   - intent commands cannot express the operation.

### CLI Freshness Commands

Use these from the repo root:

```bash
npm run refresh:global
npm run which:kb
kb "What tools are available?"
```

If global install is not desired in a given environment, use the built executable directly:

```bash
npm run build:cli
node dist/bin/kb.js "What tools are available?"
```

### Namespace Rules

- Dogfood knowledge: `KB_BASE=dogfood`
- CI / disposable test traffic: `KB_BASE=ci-*` or `KB_BASE=test-*`
- Explicit storage override when needed: `KB_BASE_DIR=/custom/path`

Examples:

```bash
export KB_BASE=dogfood
kb "Document today's implementation changes"

export KB_BASE=ci-123
kb "Run test-only documentation flow"
```

### Persistence Rules

Persistent dogfood docs are expected to be tracked in git and pushed.

```bash
git add sessions/
git commit -m "kb: checkpoint knowledge base"
git push
```

Treat KB checkpointing as part of task completion for significant work.

## Example: Ticket 001 (KB Mission and Scope)

**Acceptance Criteria:**
- A clear and reviewable markdown spec exists.
- Inputs, outputs, and error behavior are unambiguous.

**Implementation Plan Added:**
- ✅ Core mission statement (KB is semantic intermediary for agents)
- ✅ User personas (Claude via MCP, other agents, humans)
- ✅ Scope table (what we handle vs. don't handle)
- ✅ Request/response JSON shapes for Query and Write operations
- ✅ Error conditions table (validation, not-found, conflict, etc.)
- ✅ Architecture sketch (MCP server → query/write handlers → storage layer)
- ✅ Implementation priorities (tag filtering first, then full-text search, then write/conflict)
- ✅ Open questions with decisions ("Use full-text search, not embeddings, initially")

**Result:** Ticket closed. Now agents can query "What is the KB mission?" and receive this markdown. Developers can reference it when building ticket 002 (MCP server setup), ticket 003 (query handler), etc.

## Antipatterns to Avoid

### ❌ Over-Engineering the Plan
**Bad:** "We could use PostgreSQL for the index, or Redis, or Elasticsearch, or a trie structure, or…" → ticket becomes a literature review.

**Good:** "We use BM25 full-text search on markdown files. If query latency exceeds 200ms, we'll add vector embeddings in a future ticket."

### ❌ Deferring All Decisions
**Bad:** "The exact schema is TBD. We'll figure it out during implementation."

**Good:** "The exact schema is [here]. We may add fields for `author` or `approver` in future work."

### ❌ Mixing Ticket Closure with Implementation
**Bad:** Adding "Implementation Plan" but also saying "TODO: Also do X, Y, Z" → ticket isn't actually closed.

**Good:** "Ticket is closed. Ticket 012 covers X; Ticket 013 covers Y; Ticket 014 covers Z."

### ❌ Closing With Unasked Open Questions
**Bad:** Leaving `❓ Open question` in the plan and still writing "Ticket is now closed" without asking the user.

**Good:** Ask the user, record the decision (or explicit deferral), then close.

### ❌ Ignoring Deprecated Content
**Bad:** Deleting old scenarios or decisions without explanation or trace.

**Good:** Move to `TICKET_NUMBER-DEPRECATED.md` with clear explanation of why it's deprecated and what replaced it.

Example: "Scenario A was designed for Option A (unified operationMode). Deprecated in favor of Option B (specialized tools). See ticket 047-DEPRECATED_SCENARIOS.md."

### ❌ Writing the Plan After All Code
**Bad:** Code is done, then you write a confusing plan that doesn't match the code.

**Good:** Write the plan first. Use it as a spec for writing the code. If the code diverges, update the plan.

## How to Invoke This Skill

When you need to work on a ticket:

1. **Open the ticket file** from `/tickets/linear/`
2. **Start with "Implementation plan"** — don't jump to code
3. **Reference this workflow** if unsure about structure or level of detail
4. **Commit your changes** to the feature branch once the plan is done and reviewed
5. **File dependent tickets** if the plan uncovers new work

### Example Invocation

**You:** "Let's work on ticket 002 (MCP Server Setup)."

**Agent:** "I'll start by reading ticket 002, then add an Implementation Plan that covers:
- MCP server architecture (request types, tools exposed)
- Tool definitions (query_kb, write_document, etc.)
- Error handling (tool failure responses)
- Deployment/testing approach

I'll write this directly in the ticket file, then ask if the plan looks right before moving to code."

## See Also

- [KB Mission and Scope](../../tickets/linear/001-kb-mission-and-scope.md) — Example of a closed SPIKE ticket
- [Backlog Index](../../tickets/linear/_index.md) — Full list of tickets to work through
