---
layout: default
title: Testing in KB
date: '2026-04-27'
kb_id: testing-in-kb
tags:
  - testing
  - vitest
  - development
  - source-excerpt
  - claude-md
  - dogfood
  - testing-md
categories:
  - reference
---

Testing in KB uses Vitest as its test runner, which can be executed with `npm test` for a single pass or `npm run test:watch` for continuous testing. Test files mirror the source file layout, for example, `src/cli/publish-jekyll.ts` corresponds to `tests/cli/publish-jekyll.test.ts`. Tests should cover all exported functions with non-trivial logic, error paths, edge cases, and CLI parsers, including flag parsing, defaults, and conflict detection. Implementation details, private helpers, third-party library behavior, trivial getters, type-only exports, and features requiring a live LLM or network should not be directly tested. Mocking prefers real filesystems using `mkdtemp` and `rm` in `beforeEach` and `afterEach` hooks, and `vi.spyOn` for side effects. The SQLite layer should not be mocked; instead, a real in-memory DB via `better-sqlite3` should be used. A pre-commit gate, `npm run precommit`, runs lint, type-check, and the full test suite, all of which must pass before pushing.
## Testing
All non-trivial logic needs unit tests before a PR merges. See [TESTING.md](TESTING.md) for naming conventions, file layout, and what to cover.
Pre-commit gate: `npm run precommit` (lint + type-check + tests). Must pass before pushing.
# TESTING.md.
Repository excerpt captured during init (frozen snapshot of this file in the repo).
# Testing
Test runner: **Vitest**. Run with `npm test` (single pass) or `npm run test:watch`.
## Naming
```ts
describe('module or class name', () => {
it('Given <precondition>, then <expected outcome>', async () => { ... })
})
## What to test
- All exported functions with non-trivial logic
- Error paths and edge cases (empty input, missing files, hash mismatches)
- CLI parsers — flag parsing, defaults, conflict detection
- Do **not** test implementation details or private helpers directly
## What not to test
- Third-party library behaviour
- Trivial getters / type-only exports
- Things that require a live LLM or network (use `it.todo` to park them)
## Mocking
- Prefer real filesystem using `mkdtemp` / `rm` in `beforeEach` / `afterEach`
- Use `vi.spyOn` for side effects (stderr writes, external API calls)
- Avoid mocking the SQLite layer — use a real in-memory DB via `better-sqlite3`
