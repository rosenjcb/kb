# Spec manifest

Maps each `*.spec.md` to the test files it governs. Used by `pnpm run spec:check` for **per-spec** `[TC-N]` validation (TC-1 in one spec is unrelated to TC-1 in another).

| Spec file | Companion | Test dirs / files | Status |
|-----------|-----------|-------------------|--------|
| `src/server/SERVER.spec.md` | `src/server/SERVER.md` | `tests/server/` | done |
| `packages/kb-server/http/HTTP.spec.md` | `packages/kb-server/http/HTTP.md` | `packages/kb-server/http/*.http` | done |
| `src/tools/FACT_CURATOR.spec.md` | `src/tools/FACT_CURATOR.md` | `tests/tools/fact-curator.test.ts` | done |
| `src/tools/GRAPH.spec.md` | `src/tools/GRAPH.md` | `tests/tools/graph-*.test.ts`, `tests/tools/triplet-extractor.test.ts` | done |
| `src/tools/TREE_SITTER_INDEXER.spec.md` | `src/tools/TREE_SITTER_INDEXER.md` | `tests/tools/tree-sitter-indexer.test.ts`, `tests/tools/ast-source-text.test.ts` | done |
| `src/tools/TOOLS.spec.md` | `src/tools/TOOL_CONVENTIONS.md` | `tests/tools/sqlite-kb-index.test.ts`, `tests/tools/cross-repo-reconcile.test.ts`, `tests/tools/facts-*.test.ts`, `tests/tools/document-writer.test.ts`, `tests/tools/query-expander.test.ts`, `tests/tools/invalidate-fact-tool.test.ts`, `tests/tools/kb-tools-registry-no-doc-writes.test.ts`, `tests/tools/specialized-document-operations.test.ts`, `tests/tools/task-tool.test.ts`, `tests/tools/subagent-*.test.ts`, `tests/tools/retrieval-checkpoint-orchestrator.test.ts`, `tests/tools/markdown-md-writer-tool.test.ts`, `tests/tools/query-trace.test.ts` | done |
| `src/core/CORE.spec.md` | `src/core/facts-architecture.md` | `tests/core/` | done |
| `src/cli/CLI.spec.md` | `src/cli/CLI.md` | `tests/cli/` | done |
| `eval/EVAL.spec.md` | `eval/EVAL.md` | `tests/eval/`, `tests/eval-*.test.ts` | done |
| `src/core/TUI.spec.md` | `src/core/TUI.md` | `tests/tui/` | done |
| `src/intents/INTENTS.spec.md` | `src/intents/INTENTS.md` | `tests/intents/` | done |
| `src/prompts/PROMPTS.spec.md` | `src/prompts/README.md` | `tests/prompts/` | done |
| `src/ui/UI.spec.md` | — | `tests/ui/` | done |
| `scripts/SCRIPTS.spec.md` | `scripts/INSTALL.md` | `tests/scripts/` | done |

**Excluded from `TOOLS.spec.md`** (own specs above): `fact-curator`, `graph-*`, `triplet-extractor`, `tree-sitter-indexer`, `ast-source-text`.

Run `pnpm run spec:check` after changing specs or test tags.

**Gate:** every `TC-N` row in a spec must have ≥1 `[TC-N]` test in scope. Untagged tests are allowed.
