---
type: "Guide"
title: "Testing"
description: "How tests are organized and run in the KB repo using Vitest."
resource: ./tests
tags: [testing, vitest, development]
timestamp: 2026-06-20T00:00:00Z
---

# Testing

Test runner: **Vitest**. Run with `pnpm test` (single pass) or `pnpm run test:watch`.

## File layout

Source files mirror their tests:

```
src/cli/publish-cli.ts   →   tests/cli/publish-cli.test.ts
src/core/publish/notion-sync.ts   →   tests/core/notion-sync.test.ts
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

## Eval framework tests

Tests for the MOEL evaluation framework live in `tests/eval/` and mirror the `eval/` source tree:

```
eval/losses/ast-loss.ts          →  tests/eval/ast-loss.test.ts
eval/losses/moel.ts              →  tests/eval/moel.test.ts
eval/validators/manifest-*.ts    →  tests/eval/manifest-validator.test.ts
eval/reports/summary.ts          →  tests/eval/summary.test.ts
eval/tools/filesystem-tools.ts   →  tests/eval/filesystem-tools.test.ts
eval/compaction.ts               →  tests/eval/compaction.test.ts
```

Additional patterns specific to eval tests:

- **`tests/eval-run.test.ts`** — harvest parser, `computeSuccessScore`, `kbControlVerdict`, trends helpers. Headline grade ΔS lives in `scripts/eval-shared.mjs` + `scripts/control-core.mjs` (`buildControlComparison`).

- **Real git repos in tests**: `ManifestValidator` needs git. Use `mkdtemp` + `git init` + `git config commit.gpgsign false` in `beforeEach`. Always set `user.email` and `user.name` before the first commit.
- **Temp dirs for filesystem tests**: `FilesystemTool` tests use `mkdtemp` / `rm` pairs in `beforeEach` / `afterEach` — same as the rest of the project.
- **No LLM calls in unit tests**: `MutationValidator` and `runJury` require running subprocesses or LLMs. Park these as `it.todo` or write integration fixtures instead.
- **Pure function bias**: prefer testing `extractManifest`, `buildSummaryJson`, `computeMoel` (pure) over the git-/LLM-integrated validators.

## Integration tests (HTTP server)

Black-box suite for `kb server start` — **not** Vitest. Spins up Docker (`kb-server` + WireMock `llm-mock`), runs [`packages/kb-server/http/server.http`](packages/kb-server/http/server.http) via httpyac, tears down.

```bash
pnpm run integration:test
```

- **CI:** `.github/workflows/integration.yml` on **push to `main`** (and `workflow_dispatch`). Not part of feature-branch `ci.yml`.
- **LLM in CI:** WireMock sidecar — no secrets required with current runner. Repo secrets can be wired in `integration.yml` if you move to a real provider on main.
- **Requirements:** Docker + `docker compose`. First boot clones `KB_GIT_REPOS` (default: small public repo) before `/healthz` reports `indexMtime`.
- **Unit coverage:** in-process handlers live in `tests/server/`; integration exercises the full container stack.

See [`packages/kb-server/http/HTTP.md`](packages/kb-server/http/HTTP.md), [`packages/kb-server/INTEGRATION_TEST.md`](packages/kb-server/INTEGRATION_TEST.md), [`packages/kb-server/docker/wiremock/WIREMOCK.md`](packages/kb-server/docker/wiremock/WIREMOCK.md).

## Pre-commit gate

`pnpm run precommit` runs lint, type-check, and the full test suite. All must pass before pushing.
