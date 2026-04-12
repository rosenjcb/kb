# AGENTS

Repository-level operating rules for coding agents in this workspace.

## Always-On Dogfood Requirement

For all meaningful development work, agents must document decisions and outcomes in the KB using the CLI.

This is mandatory and does not depend on skill invocation.

## Required Agent Workflow

1. Ensure fresh CLI access before significant work:
   - npm run refresh:global
   - npm run which:kb
2. Use KB docs during execution, not only at the end.
3. Keep test data isolated from persistent docs:
   - Persistent work: set KB_NAMESPACE=dogfood
   - Disposable automation: KB_NAMESPACE=ci-* or KB_NAMESPACE=test-*
4. Treat persistence as part of completion:
   - git add sessions/
   - git commit -m "kb: checkpoint knowledge base"
   - git push

## Open-Question Gate (Mandatory)

When a ticket implementation plan contains any unresolved/open question, the agent must explicitly ask the user for a decision before closing the ticket.

Allowed outcomes before closure:

1. User provides a decision and the ticket is updated accordingly.
2. User explicitly approves deferral with a time-box and follow-up ticket reference.

If neither happened, do not mark the ticket closed.

When practical, ask unresolved decisions as multiple-choice prompts:

1. Present 2-5 concrete options.
2. Mark one recommended default.
3. Allow user freeform override.

This is preferred for speed, consistency, and easier agent handoff.

## CLI Fallback

If global kb is unavailable in the environment:

- npm run build:cli
- node dist/bin/kb.js "What tools are available?"

## Storage Intent

- Dogfood docs are expected to be durable and Git-tracked.
- CI/test namespaces are disposable and should not pollute persistent KB context.

## Enforcement Intent

If a task is completed without KB documentation for significant architectural, behavioral, or process changes, the task should be considered incomplete until KB docs are updated.

## Deprecation and Cleanup Policy

When design decisions change or scenarios become obsolete:

1. **Mark clearly**: Use `DEPRECATED` label in section headers or filename prefix.
2. **Provide reason**: Always explain *why* something was deprecated (e.g., "Chosen Option B instead; see ticket 047 for rationale").
3. **Archive strategically**:
   - Small deprecated sections → Keep in original file with `## DEPRECATED` header
   - Large deprecated scenarios → Move to companion `{FILENAME}-DEPRECATED.md` file
   - Entire deprecated tickets → Mark as archived in _index.md with deprecation note
4. **Link forward**: Document what replaced the deprecated approach (new tool, pattern, decision).
5. **Preserve for learning**: Deprecated docs help future agents understand "why not X" and provide context for architectural trade-offs.

**Example:**

```markdown
## DEPRECATED: Scenario D (Option A Design)

This scenario was designed for Option A (unified write_document with operationMode).
It was deprecated in favor of Option B (specialized tools) because [reason].

See [047-DEPRECATED_SCENARIOS.md](047-DEPRECATED_SCENARIOS.md) for archived details.
New implementation uses [merge_documents](src/tools/MergeDocumentsTool.ts) instead.
```

**When to deprecate:**
- Design decisions are reversed or overridden (user approval, new learning)
- Code patterns are replaced with better alternatives
- Specification sections become obsolete due to refactoring
- Tools or approaches are superseded by new tools

Treat deprecation as part of code quality: stale guidance is worse than no guidance.
