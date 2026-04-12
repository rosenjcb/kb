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

#### Integration Points
[How does this connect to other tickets or systems? What's next?]

#### Validation & Closure
This implementation plan establishes:
- ✅ [Acceptance criterion 1 is satisfied]
- ✅ [Acceptance criterion 2 is satisfied]
- ✅ [Acceptance criterion 3 is satisfied]

**Ticket [NUMBER] is now closed.**
```

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
