---
layout: default
title: Testing in KB
date: '2026-05-03'
kb_id: testing-in-kb
tags:
  - testing
  - vitest
  - development
  - source-excerpt
  - claude-md
  - kb
  - testing-md
categories:
  - reference
---

Testing in the KB project is primarily done using Vitest. Tests are run with `npm test` for a single pass or `npm run test:watch` for continuous monitoring. The file layout for tests mirrors the source files, with test files residing in a `tests/` directory that reflects the `src/` structure (e.g., `src/cli/publish-jekyll.ts` has a corresponding test at `tests/cli/publish-jekyll.test.ts`). Naming conventions for tests follow a `describe('module or class name', () => { it('Given <precondition>, then <expected outcome>', async () => { ... }) })` pattern. All exported functions with non-trivial logic, error paths, edge cases, and CLI parsers should be tested. Implementation details, private helpers, third-party library behavior, trivial getters, type-only exports, and features requiring a live LLM or network are explicitly not to be tested, with `it.todo` used to mark future tests for LLM/network-dependent features. Mocking prefers real filesystems using `mkdtemp`/`rm` in `beforeEach`/`afterEach` hooks, `vi.spyOn` for side effects, and avoids mocking the SQLite layer by using a real in-memory DB via `better-sqlite3`. A pre-commit gate, `npm run precommit`, runs lint, type-check, and the full test suite, all of which must pass before pushing changes.
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
