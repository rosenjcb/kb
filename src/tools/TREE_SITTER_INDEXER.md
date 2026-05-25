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
6. Run `npm install` — some grammars need `legacy-peer-deps` (see root `.npmrc`).

**No WASM (do not wire):** `tree-sitter-kotlin`, `tree-sitter-yaml` (native-only packages) — keep as text fallback or LLM `SOURCE_CODE_EXTENSIONS`.

## Export query convention

Symbol name capture must use `@name`. Multi-capture queries (e.g. HTML `id` attribute) rely on `match.captures.find(c => c.name === 'name')` in the indexer loop — do not assume `captures[0]` is the symbol.

Go uses `goExportConvention: true` — only uppercase-initial identifiers become symbols.

## Import edges

`IMPORTS_FILE` only resolves **local** specifiers (`.` or `/` prefix). Resolution tries bare path + common TS/JS suffixes. Other languages with import queries (Ruby `require`, PHP `include`) follow the same local-only rule.

## Text fallback

Extensions in `TREE_SITTER_TEXT_EXTENSIONS` but not `EXT_MAP` get a **file node only** (`language='text'`, no symbols). Used for markdown, yaml, json, dockerfile, etc.

## Integration

- **Init:** `code-index` cycle in `init-cli.ts` runs ts-morph first (when `tsconfig.json` exists), then tree-sitter over indexable paths.
- **Incremental:** per-file content hash stored in the indexer — unchanged files increment `skipped`.
- **Facts:** `ast-promote.ts` reads `props_json.source_text` on symbol nodes → `facts.source_text` (see [`../core/AST_SOURCE_TEXT.md`](../core/AST_SOURCE_TEXT.md)).

## Operational notes

- Grammar load failure per file → falls through to text-node-only (no throw on whole project).
- `TREE_SITTER_SKIP_DIRS` mirrors common vendor/build dirs; extend when new ecosystems add huge trees.
- Ts-morph owns TS/JS when present; tree-sitter TS queries still exist for projects without `tsconfig.json`.
