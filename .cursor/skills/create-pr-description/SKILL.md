---
name: create-pr-description
description: "Use when: preparing a GitHub pull request summary; converting branch changes into a structured PR body with clear Description, Changes made, and Tests sections."
---

# Create PR Description

## Purpose

Generate a high-signal GitHub PR description that helps reviewers quickly understand:

1. The problem being solved and why it matters.
2. What changed in the repository.
3. How the change was validated.

## Output Format (Required)

Use exactly these section headers:

```markdown
# Description

# Changes made

# Tests
```

## Workflow

1. Determine base branch and compare scope.
   - Prefer `main...HEAD` unless user specifies another base.
2. Gather change context.
   - `git diff --name-only <base>...HEAD`
   - `git diff --stat <base>...HEAD`
   - Optional: inspect key files for behavior-impacting details.
3. Summarize intent in plain language.
   - Focus on user/problem impact first, then implementation.
4. Summarize changes at a high level.
   - Group by theme (CLI, core loop, tests, docs, policy).
   - Avoid line-by-line changelog unless requested.
5. Summarize validation evidence.
   - Include automated checks (type-check, unit tests, integration tests).
   - Include manual/functional checks if performed.
   - Be explicit about anything not run.
6. Output to `.tmp/pr-description.md` (not pushed to git).
   - User can copy from the file directly.

## Writing Rules

- Keep it reviewer-friendly and concise.
- Use bullet points under each section.
- Prefer outcomes over implementation trivia.
- Mention notable trade-offs and follow-ups.
- Do not invent tests or results.

## Tests Section Guidelines

Tests should be **descriptive scenarios**, not just CI commands:

**✓ Good:**
- Tested document creation with collision suffix generation (dayjs-based) — verified overwrite flag behavior.
- Tested global CLI installation via `npm install -g .` and `npm run refresh:global`.
- Tested 13 unit test suites (vitest) post-dayjs migration: agent-loop, llm-provider, document-writer, markdown-md-writer — all passing.
- Tested TypeScript type-checking after Node types configuration — 73 errors resolved.
- Tested namespace-isolated KB storage routing with TEST_NAMESPACE env variable.

**✗ Avoid:**
- pnpm run type-check
- npm test
- git diff --stat main...

## Template

```markdown
# Description
- [Problem statement]
- [Why this matters]
- [Scope of this PR]

# Changes made
- [High-level change group 1]
- [High-level change group 2]
- [High-level change group 3]

# Tests
- [Automated test command + outcome]
- [Functional/manual validation + outcome]
- [Any gaps or not-run checks]
```

## Optional Add-ons (when useful)

- Risks and mitigations
- Rollback notes
- Follow-up tickets

## Example Prompt

"Create a PR description for this branch against main using the required headings and include all validation performed."
