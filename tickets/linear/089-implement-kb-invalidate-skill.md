# Implement `kb invalidate` Skill

## Ticket ID
089

## Theme
cli-ux / document hygiene / agent tools

## Problem

There is recurring confusion around the intended behavior of `kb invalidate`. The command should be a KB-only cleanup tool that searches for and prunes (optionally replaces) outdated facts or statements inside the active SQLite-backed knowledge base. It must not scan or edit source code or arbitrary repo files.

## Scope

- Implement a new CLI and agent skill: `kb invalidate <old-fact> [<replacement-fact>]`
- The skill will:
  - Search the active KB SQLite store for the old fact
  - For each match, present a diff or summary to the user/agent
  - If a replacement is provided, perform KB-document replacement; otherwise, prune/remove the matched fact
  - Log/document all changes for review and traceability
- The tool will follow the “single responsibility” pattern: one tool for invalidate/prune/replace, not a polymorphic edit tool.
- Keep the implementation inside the KB storage layer; do not use repo-wide file edit primitives.

## Acceptance Criteria

- CLI and agent skill exist for `kb invalidate <old-fact> [<replacement-fact>]`
- Skill can search, preview, and apply changes across KB documents only
- Supports preview, dry-run, and apply modes
- All changes are logged and reviewable
- Tests and documentation are updated

## Dependencies

- TOOL_CONVENTIONS.md
- sqlite-document-writer.ts
- sqlite-kb-index.ts

## Deliverables

- CLI handler and intent contract for `kb invalidate`
- Tool logic for KB-only search, preview, and apply
- Tests and documentation

## Estimate
L

## Priority
High

---

## Implementation Plan

### Background
There is recurring confusion around the intended scope of `kb invalidate`. The need is real, but the action must stay constrained to KB documents stored in SQLite—e.g., replacing “We deploy to GCP” with “We deploy to AWS” inside stored knowledge, not source code.

### Approach
- Implement a new CLI and agent skill: `kb invalidate <old-fact> [<replacement-fact>]`
- The skill will:
  1. Search the active KB SQLite documents for the old fact
  2. For each match, present a diff or summary to the user/agent
  3. If a replacement is provided, perform KB-document replacement; otherwise, prune/remove the matched fact
  4. Log/document all changes for review and traceability
- The tool will follow the “single responsibility” pattern: one tool for invalidate/prune/replace, not a polymorphic edit tool.
- Keep storage mutations inside the KB layer so chunks/FTS stay in sync.

### CLI/Intent Contract
- `kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]`
- Skill/intent: `invalidate_fact`
  - Input: `{ oldFact: string, replacementFact?: string, preview?: boolean, dryRun?: boolean }`
  - Output: List of KB documents changed, summary of diffs, error if no matches found

### Search/Prune/Replace Logic
- Use SQLite-backed KB document enumeration and exact-text replacement
- Present a preview of all matches before applying changes
- For each match:
  - If replacement provided, replace in the stored KB document
  - If not, remove the matched text from the stored KB document
  - Reindex updated document content so lexical/FTS retrieval stays current

### Reference Patterns
- Use the separation-of-concerns tool pattern from `src/tools/TOOL_CONVENTIONS.md`
- Model after KB storage mutation patterns in `sqlite-document-writer.ts`
- Register as a new tool/CLI action without broad repo file-edit scope

### Validation & Closure
This implementation establishes:
- ✅ `kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]` exists on the consumer CLI
- ✅ The implementation is constrained to KB-only cleanup of SQLite-backed documents and does not scan arbitrary repo files
- ✅ Updated documents are reindexed through the KB storage layer so retrieval stays in sync
- ✅ Focused tests cover replacement, removal, no-match behavior, and the “do not touch unrelated repo files” boundary
- ✅ README, skill docs, and tool conventions now describe invalidate as a KB cleanup command rather than a source refactor

**Ticket 089 is now closed.**
