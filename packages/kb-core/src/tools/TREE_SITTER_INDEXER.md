---
type: "Module"
title: "Tree-Sitter Code Graph Indexer"
description: "How TreeSitterIndexer parses source into the code graph using WASM grammars with no native compile."
resource: ./src/tools/tree-sitter-indexer.ts
tags: [tree-sitter, indexer, code-graph]
timestamp: 2026-08-23T21:00:00Z
---

# Tree-Sitter Code Graph Indexer

`tree-sitter-indexer.ts` implements `TreeSitterIndexer` — WASM grammars via `web-tree-sitter`, no native compile. Semantic graph context: [`GRAPH.md`](GRAPH.md).

## Registry

Two maps must stay aligned:

- `LANG_CONFIGS` — language key → `wasmPath`, import/export tree-sitter queries, `goExportConvention`
- `EXT_MAP` — file extension → language key

Exported: `TREE_SITTER_AST_EXTENSIONS` (keys of `EXT_MAP`), `TREE_SITTER_TEXT_EXTENSIONS`, `isTreeSitterIndexablePath()`.

## Adding a language

1. Confirm npm package ships `tree-sitter-<lang>.wasm` (inspect `node_modules` after install).
2. Add `LANG_CONFIGS` entry with `resolveWasm('tree-sitter-<lang>', '<file>.wasm')`.
3. Add extensions to `EXT_MAP`.
4. Remove extension from `TREE_SITTER_TEXT_EXTENSIONS` if it was text-only.
5. Add vitest fixture under `tests/tools/tree-sitter-indexer.test.ts`.
6. Run `pnpm install` — some grammars need `legacy-peer-deps` (see root `.npmrc`).

**No WASM (do not wire):** `tree-sitter-kotlin`, `tree-sitter-yaml` (native-only packages). Kotlin/Swift source files are not AST-indexed today; there is no LLM fallback.

## Export query convention

Symbol name capture must use `@name`. Multi-capture queries (e.g. HTML `id` attribute) rely on `match.captures.find(c => c.name === 'name')` in the indexer loop — do not assume `captures[0]` is the symbol.

Go uses `goExportConvention: true` — only uppercase-initial identifiers become symbols.

## Import edges

`IMPORTS_FILE` only resolves **local** specifiers (`.` or `/` prefix). Resolution tries bare path + common TS/JS suffixes. Other languages with import queries (Ruby `require`, PHP `include`) follow the same local-only rule.

## Text fallback

Extensions in `TREE_SITTER_TEXT_EXTENSIONS` but not `EXT_MAP` get a **file-level
`code_symbol`** (`kind: file`, basename as name, capped `source_text` prefixed
with the relative path). Discovery still records `code_file_state`; without the
symbol row, hybrid retrieval cannot see the file. Used for markdown, yaml, json,
dockerfile, `.fish`, etc. Parse failures on AST languages take the same file-level
symbol path so the file is not invisible.

## Integration

- **Init:** `code-index` cycle in `init-cli.ts` runs tree-sitter over every indexable path — it is the sole code indexer for all languages (TS/JS included).
- **Incremental:** per-file content hash stored in the indexer — unchanged files increment `skipped` **only when searchable rows already exist**. A legacy text-only state row (hash match, zero symbols) is re-indexed to emit the file-level symbol (no need to change bytes or wipe state).
- **Facts:** `ast-promote.ts` reads `props_json.source_text` on symbol nodes → `facts.source_text` (see [`../core/AST_SOURCE_TEXT.md`](../core/AST_SOURCE_TEXT.md)).

## Operational notes

- Grammar load failure per file → file-level symbol fallback (no throw on whole project).
- `TREE_SITTER_SKIP_DIRS` mirrors common vendor/build dirs; extend when new ecosystems add huge trees.
- Coverage audit: `kb graph --file <relPath>` exits non-zero when state exists without searchable rows, or when the index DB is missing.

## Related docs

- Behavioral spec → [`TREE_SITTER_INDEXER.spec.md`](TREE_SITTER_INDEXER.spec.md)
