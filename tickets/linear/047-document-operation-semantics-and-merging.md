# Document operation semantics and intelligent merging strategy

## Ticket ID
047

## Theme
local-kb

## Problem

Current document operations (write, query) handle basic create/update/conflict scenarios, but lack patterns for:

1. **Document updates with content merging**: When a document update arrives, how do we intelligently merge content vs. replace wholesale?
2. **Duplicate document consolidation**: When similar documents of the same type exist (e.g., two "Authentication Design" docs with different IDs), should they be merged? By what rules?
3. **Pruning and content removal logic**: When deleting/pruning content, how do we decide: delete entire document vs. edit specific sections vs. archive?
4. **Document type awareness**: How does the system differentiate between document types (decision log, architecture, checklist, runbook) to apply operation semantics correctly?

These decisions affect:
- Agent decision logic (should I merge or create new?)
- User experience (are duplicate docs confusing?)
- Data quality (orphaned fragments vs. consolidated truth)
- Tool design (do we need new tools: merge_document, prune_document, update_document_section?)

## Scope

### In Scope
- Define document operation intent patterns (full replace vs. append vs. merge)
- Document type taxonomy and differentiation rules
- Merging heuristics (what constitutes a merge candidate?)
- Pruning decision framework (when to delete vs. edit)
- Tool design questions: single unified update tool vs. specialized tools

### Out of Scope
- Multi-user conflict resolution (still single-user MVP)
- Approval workflows
- Full diff/patch system (that's future infrastructure)
- Blob storage or large attachments

## User Scenarios

1. **Scenario A: Append-style update**
   - "Add a new decision to the decision log"
   - Current doc ID: `decision-log-2024-q2`
   - Incoming: append new entry
   - Expected: existing content + new entry, not a wholesale replace

2. **Scenario B: Duplicate detection and merge**
   - KB has doc A: "Authentication Design v1" (2 months old, ID: `auth-design-jan`)
   - Agent generates doc B: "Authentication Design v2" (ID: `auth-design-apr`)
   - Today: two docs exist, potential confusion
   - Question: Should system auto-detect and merge? Or alert user? Or just create new?

3. **Scenario C: Surgical pruning**
   - Doc: "Deployment Runbook" with sections: Overview, Steps, Rollback, Deprecated Commands
   - Need: remove "Deprecated Commands" section only
   - Today: no tool for partial updates; would need to read + edit + write full doc
   - Question: Use regex/section removal? Or structured sections with CRUD per section?

4. **Scenario D: Document type-aware operations**
   - Type A: Decision logs (append preferred, immutable history)
   - Type B: Checklists (items can be added/removed, order matters)
   - Type C: Reference docs (full replace is OK)
   - Same operation (add content) should behave differently per type
   - Question: Who decides document type? Schema metadata?

## Acceptance Criteria

- [ ] Document operation intent taxonomy is defined (append, merge, replace, prune, etc.)
- [ ] Document type system is designed (tags? schema? metadata?)
- [ ] Merging heuristics are documented (what makes two docs "the same"?)
- [ ] Pruning decision framework exists (delete vs. edit rules)
- [ ] Tool design decision is made (unified vs. specialized tools)
- [ ] Open questions are listed with proposed answers
- [ ] Runbook/examples exist for each scenario

## Open Questions

1. **Tool proliferation**: Do we add `update_document`, `merge_documents`, `delete_document_section`? Or keep `write_document` as the catch-all with structured inputs?
   - Option A: Single `write_document` with operation mode (append, merge, replace)
   - Option B: Specialized tools per operation (cleaner semantics, more tools)
   - Option C: Hybrid (write_document + optional helpers for common patterns)

2. **Duplicate detection**: What makes two documents "duplicates"?
   - Exact title match?
   - Semantic similarity (fuzzy match)?
   - Explicit tag/category metadata?
   - LLM-based similarity?

3. **Merging conflict resolution**: If two docs conflict, who decides the merge?
   - Always manual (user approves)?
   - Agent decides (with parameters)?
   - Deterministic rules (timestamp wins, length wins, manual merge)?

4. **Document type system**: How do we encode document type knowledge?
   - Hardcoded in code (not extensible)
   - Metadata tags in frontmatter (extensible, requires schema)
   - AI-inferred per operation (flexible, risky)

5. **Rollback/recovery**: If a merge or prune goes wrong, can we recover?
   - Keep deleted sections in archive?
   - Full document version history?
   - Git-backed diffs?

## Dependencies
- 002 (DocumentWriter contract — may need extension for merging)
- 007 (Storage layout — may need section/chunk metadata)
- 008 (Naming/collision policy — interacts with merge decisions)

## Deliverables

1. **Document Operation Intent Taxonomy** markdown section
   - Define operation types (create, append, merge, replace, prune)
   - Describe each with use cases and constraints

2. **Document Type System Design** markdown section
   - Propose type taxonomy (decision, runbook, checklist, reference, etc.)
   - Schema/metadata proposal

3. **Merging Heuristics and Framework** markdown section
   - Define what makes docs mergeable
   - Conflict resolution rules
   - Examples

4. **Pruning Decision Rules** markdown section
   - When to delete whole doc vs. edit
   - Archive strategy (if any)

5. **Tool Design Proposal** markdown section
   - Recommend A/B/C for tool proliferation
   - Propose tool signatures and inputs

6. **Scenario Walkthroughs** markdown section
   - For each of scenarios A–D, show expected flow with chosen tools

## Estimate
M (1–2 day spike to explore and document)

## Priority
HIGH (blocks informed tool design; affects agent decision logic)

## Notes

- This ticket is exploratory (SPIKE); the goal is to document the architectural landscape and propose solutions, not implement.
- User should review and approve the document operation semantics before tool development proceeds.
- Findings should inform tool design tickets (e.g., update_document, merge_documents tools).

---

## Implementation Plan

### Document Operation Semantics and Intelligent Merging Framework

#### Background

Current `write_document` tool handles basic CRUD (create with collision detection, overwrite flag) but lacks patterns for:
- Merging duplicate documents (e.g., "Auth Design v1" + "Auth Design v2")
- Intelligent update semantics (append to decision log vs. replace runbook)
- Surgical content removal (delete one section, keep rest)
- Type-aware operation defaults (what should append vs. replace?)

As agents interact with the KB repeatedly and humans refactor docs, these gaps create decisions agents can't make safely, leading to either duplicates or accidental loss of content.

#### Approach

**Unified tool strategy with type-driven semantics:**

1. Extend `write_document` with `operationMode` parameter (create, append, merge, replace, prune)
2. Document type metadata in frontmatter (YAML tags)
3. Merging heuristics: title similarity >70% + same type = merge candidate
4. Pruning rules: delete whole doc vs. edit section patterns
5. Backward compatible: existing `write_document(overwrite=true)` → `operationMode="replace"`

This keeps API surface small (one tool) while enabling rich semantics internally. Type metadata governs defaults (e.g., decision logs append by default; reference docs replace by default).

#### Document Operation Intent Taxonomy

**Create** - New document, expects unique ID
- Input: title, content, optional documentId  
- Output: {id, title, createdAt, updatedAt, status: "created"}
- Use case: First decision doc, new runbook  
- Behavior: Fails if ID already exists (unless overwrite=true)

**Append** - Add content without modifying existing
- Input: documentId, contentToAppend, position (top/bottom)  
- Output: {id, title, updatedAt, status: "updated"}
- Use case: Decision log entries, meeting notes  
- Constraint: Original content is immutable; new content appended

**Merge** - Combine two documents into one
- Input: sourceDocId, targetDocId, mergeStrategy (keep-source/keep-target/manual)
- Output: {id, title, mergedDocIds: [sourceId], status: "merged"}
- Use case: "Auth Design v1" + "Auth Design v2" → consolidated  
- Note: Manual review recommended for high-impact docs

**Replace** - Wholesale content replacement
- Input: documentId, newContent, type  
- Output: {id, title, updatedAt, status: "updated"}
- Use case: Refresh stale runbooks, update decision rationale  
- Constraint: Old content available in git history

**Prune** - Remove specific content from document
- Input: documentId, targetPattern (section name or regex)
- Output: {id, title, updatedAt, status: "updated"}
- Use case: Remove "Deprecated Commands" from runbook  
- Constraint: Content retained in git history

#### Document Type System

**Proposed metadata in frontmatter:**

```yaml
---
title: "Authentication Architecture"
documentId: "auth-design-2024-q2"
type: "architecture"          # One of: architecture, decision, checklist, runbook, reference
createdAt: "2024-02-15T10:00:00Z"
updatedAt: "2024-04-12T14:30:00Z"
tags: ["security", "auth", "critical"]
version: "2"
---
```

**Type behavior matrix:**

| Type | Default Operation | Merge Allowed? | Prune Common? | Replace OK? |
|------|-------------------|----------------|---------------|-----------|
| architecture | replace | Yes | No | Yes |
| decision | append | Yes | No | No |
| checklist | append | Yes | Yes | No |
| runbook | replace | Yes | Yes | Yes |
| reference | replace | Yes | No | Yes |

#### Merging Heuristics

**Two documents are merge candidates if:**
1. Same type (both "architecture" or both "decision")
2. Title similarity ≥ 70% (fuzzy match via Levenshtein distance)
3. Same author or KB agent
4. Tag overlap (e.g., both tagged "security")

**Conflict resolution (deterministic order):**
1. Keep newer document (by timestamp)
2. Keep longer document (more content)
3. Manual review (if tie-breaker needed)

**Example:** "Auth Design v1" (createdAt: Jan 2024, length: 800 chars) vs. "Auth Design v2" (createdAt: Apr 2024, length: 1200 chars) → Keep v2 (newer + longer).

#### Pruning Decision Rules

**Delete entire document if:**
- Document explicitly marked `archived: true`
- Content is 100% superseded by another document (verified via query)
- Low relevance + no active references

**Edit document (keep document, remove section) if:**
- Removing only specific section (runbook: remove "Rollback" but keep "Steps")
- Document is runbook or reference (sections often age independently)
- Section is marked `deprecated: true` in metadata

**Archive strategy:** Git history is the retention layer. Deleted content stays in `git log`. No separate `.archive/` folder needed for MVP.

#### Tool Design Recommendation

**Chosen: Option B — Specialized tools per operation (write_document, update_document, merge_documents, append_to_document, prune_document)**

**Rationale (informed by `claude-code` codebase pattern):**
- Separation of concerns: Each tool has a single, clear responsibility
- Tool names document intent: agent immediately knows what `merge_documents` does
- No polymorphic parameter confusion: no `operationMode` parameter to interpret
- Precedent in production: claude-code uses separate FileReadTool, FileEditTool, FileWriteTool; separate TaskCreateTool, TaskUpdateTool, TaskGetTool, TaskListTool, etc.
- Each tool gets its own prompt/schema/error handling
- Easier to reason about and test

**Tool suite:**
- `write_document`: Create new document (existing behavior, mostly unchanged)
- `append_to_document`: Add content to existing doc (decision logs, notes)
- `update_document`: Replace content wholly (reference docs, runbooks)
- `merge_documents`: Consolidate duplicate docs (with user approval or auto-merge mode)
- `prune_document`: Remove sections/content (surgical edits)

**Alternative evaluation:**
- Option A (unified + operationMode): Rejected—parameter-driven polymorphism; harder for agents
- Option C (hybrid): Unnecessary—Option B is already lightweight

**Benefits over Option A:**
```
// Option A (rejected):
write_document({
  documentId: "auth-design",
  content: "...",
  operationMode: "merge",
  mergeStrategy: "keep-target"
})
// ↑ Agent has to understand 4+ parameters, reasoning unclear

// Option B (chosen):
merge_documents({
  sourceDocId: "auth-design-apr",
  targetDocId: "auth-design-jan",
  mergeMode: "auto" // or "user-decides"
})
// ↑ Tool name documents intent; fewer parameters to reason about
```

#### Scenario Walkthroughs

**Scenario A: Append-style update (Decision log)**
```
User query: "Add Q3 architecture decision"

Agent calls: write_document({
  documentId: "decision-log-2024",
  operationMode: "append",
  content: "### Q3: Migrate to turborepo for monorepo builds",
  type: "decision"
})

Result:
{
  id: "decision-log-2024",
  status: "updated",
  updatedAt: "2024-04-12T15:30:00Z",
  note: "Appended 1 entry to decision log"
}

Existing entries preserved; new entry added at bottom.
```

**Scenario B: Duplicate detection and merge**
```
Agent calls: write_document({
  title: "Authentication Architecture v2 - OAuth 2.0 Integration",
  operationMode: "create",
  type: "architecture"
})

System detects collision: "Authentication Architecture" exists (ID: auth-design-jan)
- Title similarity: 82% (match)
- Same type: Yes
- Analysis: This is a merge candidate

Response (409 MERGE_AMBIGUOUS):
{
  status: "conflict",
  code: "MERGE_CANDIDATE",
  suggestion: {
    message: "Similar document exists: 'Authentication Architecture' (auth-design-jan)",
    options: [
      "merge (keep existing + new as merged doc)",
      "create-new (keep both as separate docs)",
      "replace (overwrite existing with new)"
    ]
  }
}

User approves merge. Agent calls:
write_document({
  sourceDocId: "auth-design-apr",  // newly published ID
  targetDocId: "auth-design-jan",  // existing ID
  operationMode: "merge",
  mergeStrategy: "keep-target"     // Keep newer one
})

Result:
{
  id: "auth-design-jan",
  status: "merged",
  mergedDocIds: ["auth-design-apr"],
  note: "Merged 2 versions; old version archived in git"
}
```

**Scenario C: Surgical pruning**
```
User query: "Remove Deprecated Commands from deployment runbook"

Agent calls: write_document({
  documentId: "deploy-runbook-2024",
  operationMode: "prune",
  prunePattern: "Deprecated Commands",
  type: "runbook"
})

Result:
{
  id: "deploy-runbook-2024",
  status: "updated",
  updatedAt: "2024-04-12T15:35:00Z",
  note: "Removed section: Deprecated Commands (content in git history)"
}

Runbook retains Overview, Steps, Rollback sections; only Deprecated Commands removed.
```

**Scenario D: Type-aware operation defaults**

- **Architecture doc** (type="architecture"): Agent wants to "append new design pattern"
  - Default behavior: `operationMode="replace"` (architectures are versioned, not incremental)
  - Agent must explicitly set `operationMode="append"` if desired

- **Decision doc** (type="decision"): Agent wants to "add Q3 decision"
  - Default behavior: `operationMode="append"` (decisions are immutable log)
  - If agent wants `replace`: Must explicitly set `operationMode="replace"`

- **Checklist** (type="checklist"): Agent wants to "add validation step"
  - Default behavior: `operationMode="append"` (items added to list)

#### Error Conditions / Edge Cases

| Scenario | Behavior | Response |
|----------|----------|----------|
| Prune pattern matches nothing | Warn user; suggest available sections | 400 BAD_REQUEST: "Section 'Deprecated Commands' not found. Available: [Overview, Steps, Rollback]" |
| Two merge candidates exist (ambiguous) | Return ambiguity error; require user choice | 409 MERGE_AMBIGUOUS: "Multiple docs match. Specify target." |
| Merge with conflicting type tags | Warn; recommend manual review | 409 MERGE_CONFLICT: "Type mismatch (architecture vs. reference). Manual review required." |
| Append to non-append doc (e.g., architecture) | Allow if explicit; warn otherwise | 200 OK (with note) or 400 if strict validation enabled |

#### Decisions Made

#### Decisions Made

- ✅ **Decided: Option B — Specialized tools per operation**
  - Rationale: Separation of concerns; tool names document intent; follows production pattern (claude-code)
  - vs. Option A (unified + operationMode): Rejected—polymorphism harder for agents
  - vs. Option C (hybrid): Unnecessary—Option B is lightweight
  - Outcome: Codified in [src/tools/TOOL_CONVENTIONS.md](../../src/tools/TOOL_CONVENTIONS.md)

- ✅ **Decided: Document type metadata in frontmatter YAML**
  - Rationale: Human-readable, extensible, agents can infer/update
  - vs. Hardcoded enums: Rejected—not extensible
  - vs. AI-inferred: Deferred; explicit tagging preferred for MVP

- ✅ **Decided: Fuzzy title match (≥70%) + LLM semantic similarity**
  - User decision: "Implement LLM similarity from the start (higher latency)"
  - Rationale: Higher precision for duplicate detection; better than thresholds
  - Levenshtein (70%) as fallback for speed; LLM-based similarity as primary
  - Semantic similarity: vectorize + cosine distance, acceptable latency hit

- ✅ **Decided: Deterministic conflict resolution (timestamp > length)**
  - Rationale: No tie-breaking, reproducible, agents can predict outcome
  - vs. Always manual: Slower, better for high-stakes decisions (users choose case-by-case)
  - vs. LLM-driven: Deferred; add only if deterministic rules too crude

- ✅ **Decided: Git history is retention layer; no archive folder for MVP**
  - User decision: "A: Git history only (current proposal, simpler)"
  - Rationale: Reduced complexity, git provides full history, users can clone previous commit
  - vs. Archive folder: Can implement in future if users need easier recovery UI
  - vs. Snapshot-based: Deferred; adds complexity without clear UX benefit

- ✅ **Decided: Merge execution mode configurable (auto or user-decides)**
  - User decision: "Make a mode that a user can select: auto merge and 'user decides'. Two scenarios we will need to support high level. Imagine a PM coming to KB store and making updates/approvals."
  - Implementation: Support both modes via `mergeMode: "auto" | "user-decides"` parameter
  - Auto mode: Merge deterministically when criteria met; audit log all merges
  - User-decides mode: Return 409 MERGE_AMBIGUOUS; require explicit approval
  - Rationale: Different workflows (agent-autonomous vs. PM-controlled) need different semantics

#### User Decision Checkpoint

**All 3 previously open questions have been resolved by user:**

1. **Merge execution**: Auto vs user-decides → **Both supported, configurable**
2. **Semantic similarity trigger**: When to switch from fuzzy? → **From the start (higher latency accepted)**
3. **Versioning strategy**: Git only vs metadata vs snapshots? → **Git history (simplest)**

All decisions now finalized and recorded above.

#### Integration Points

- **Ticket 002** (DocumentWriter): Extend interface to support merge metadata and tool modes
- **Ticket 008** (Naming/Collision): Merge interacts with collision suffix strategy (resolved docs get archived, not deleted)
- **Ticket 018** (MCP query tool): Add `type` filter to queries ("show me all decision docs")
- **Ticket 012/013** (CLI create/update): Expose specialized tools (append_to_document, update_document, merge_documents, etc.)
- **Future**: Versioning/rollback UI if users request it; performance optimization if LLM similarity latency exceeds threshold
- **Codebase**: Tool design principle codified in [src/tools/TOOL_CONVENTIONS.md](../../src/tools/TOOL_CONVENTIONS.md)

#### Validation & Closure

**Phase 1 (Planning): COMPLETE** ✅

This Implementation Plan satisfies all planning acceptance criteria:

- ✅ Document operation intent taxonomy is defined (create, append, merge, replace, prune with use cases)
- ✅ Document type system is designed (frontmatter YAML with enum + tags)
- ✅ Merging heuristics documented (≥70% title similarity, same type, tag overlap)
- ✅ Pruning decision framework exists (delete whole doc vs. edit section rules)
- ✅ Tool design decision made (Option B: specialized tools per operation)
- ✅ Open questions resolved (merge mode, semantic similarity, versioning)
- ✅ Scenario walkthroughs exist for all 4 scenarios (A: append, B: merge, C: prune, D: type-aware)
- ✅ Deprecated scenarios archived in [047-DEPRECATED_SCENARIOS.md](047-DEPRECATED_SCENARIOS.md) with rationale
- ✅ Tool design conventions codified in [src/tools/TOOL_CONVENTIONS.md](../../src/tools/TOOL_CONVENTIONS.md)
- ✅ Deprecation policy documented in [AGENTS.md](../../AGENTS.md#deprecation-and-cleanup-policy)

**Phase 2 (Implementation): IN PROGRESS** 🚀

Tools to implement (following specialized pattern from TOOL_CONVENTIONS.md):
- [ ] `write_document`: Create new document (existing, refactor for new schema)
- [ ] `append_to_document`: Add content to existing (decision logs, notes)
- [ ] `update_document`: Replace content wholly (reference docs, runbooks)
- [ ] `merge_documents`: Consolidate with auto/user-decide modes
- [ ] `prune_document`: Remove sections via pattern matching
- [ ] `query_documents`: Add type filters for semantic queries
- [ ] Tests: Unit + integration for all tools
- [ ] LLM-based semantic similarity for merge detection

**Phase 1 → Phase 2 Transition**: All user decisions finalized. Ready to code.

**Ticket 047 Phase 1 is now closed. Phase 2 (code + tests) in progress.**
