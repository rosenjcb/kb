---
name: invalidate-fact
aliases: [invalidate, prune, replace-fact]
description: >
  Use to search for and prune (optionally replace) outdated facts or statements in the active KB only. Supports preview, dry-run, and apply modes. Example: `kb invalidate "We deploy to GCP" "We deploy to AWS"`.
---

# Invalidate Fact Skill

## What does this skill do?

The `invalidate-fact` skill enables agents and users to search for and prune (optionally replace) outdated or incorrect facts inside the active KB store. It is designed to:
- Remove or replace obsolete statements (e.g., "We deploy to GCP" → "We deploy to AWS")
- Support both preview and apply modes for safe review
- Log/document all changes for traceability

## CLI Usage

```bash
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]
```

- `<old-fact>`: The fact or statement to search for and invalidate
- `<replacement-fact>` (optional): Replacement text to use instead of removal
- `--preview`: Show a summary of matches and diffs before applying changes
- `--apply`: Apply the changes (default is preview)
- `--dry-run`: Simulate changes without writing to the KB store

## Intent Contract

- Skill/intent: `invalidate_fact`
- Input: `{ oldFact: string, replacementFact?: string, preview?: boolean, dryRun?: boolean }`
- Output: List of KB documents changed, summary of diffs, error if no matches found

## Implementation Notes

- Uses KB document enumeration plus exact-text replacement
- Presents a preview of all matches before applying changes to KB documents
- Follows the single-responsibility tool pattern (see TOOL_CONVENTIONS.md)
- Reindexes updated KB documents through the SQLite storage layer

## Example

```bash
kb invalidate "We deploy to GCP" "We deploy to AWS" --preview
kb invalidate "Deprecated API endpoint" --apply
```

## Scope Boundary

- Operates on the active KB SQLite store only
- Updates stored KB documents and their search index
- Does **not** scan or edit source code, tests, or arbitrary repo files

## See Also
- [TOOL_CONVENTIONS.md](../../src/tools/TOOL_CONVENTIONS.md)
- [089-implement-kb-invalidate-skill.md](../../tickets/linear/089-implement-kb-invalidate-skill.md)
