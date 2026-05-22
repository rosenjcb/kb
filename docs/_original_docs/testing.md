---
layout: default
title: TESTING.md
date: '2026-05-22'
kb_id: testing-md
tags:
  - original-source
  - testing-md
  - kb
categories:
  - reference
---

# Testing

Test runner: **Vitest**. Run with `npm test` (single pass) or `npm run test:watch`.

## File layout

Source files mirror their tests:

```
src/cli/publish-jekyll.ts   →   tests/cli/publish-jekyll.test.ts
src/core/publish/jekyll-sync.ts   →   tests/core/jekyll-sync.test.ts
src/tools/document-writer.ts   →   tests/tools/document-writer.test.ts
```

## Naming

```ts
describe('module or class name', () => {
  it('Given <precondition>, then <expected outcome>', async () => { ... })
})
```

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

## Pre-commit gate

`npm run precommit` runs lint, type-check, and the full test suite. All must pass before pushing.
