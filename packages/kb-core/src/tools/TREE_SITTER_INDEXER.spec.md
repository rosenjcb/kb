---
type: Spec
title: "Spec: Tree-Sitter Code Graph Indexer"
sources: [./tree-sitter-indexer.ts]
tests:
  - ../../../../tests/tools/tree-sitter-indexer.test.ts
description: Behavioral specification for Tree-Sitter Code Graph Indexer
tags: [spec, kb]
timestamp: 2026-08-29T17:47:00Z
---

### Intro

Behavioral requirements. Architecture: [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- Code→code structural edges (imports/extends/implements) in v1 — symbols and source text only

### Frontend Language Support

Vue and Svelte files mix a template with a script. The indexer treats each
frontend format differently, based on how well it can parse the file.

**Embedded-script extraction (.vue, .svelte).** The indexer finds every
inline `<script>` block in the file. It skips a block that loads its code
from an external file (`src="..."`). It joins the remaining blocks into one
buffer. It picks the TypeScript grammar when any block declares `lang="ts"`
or `lang="typescript"`. Otherwise it picks the JavaScript grammar. It parses
that buffer with the same grammar and query pipeline used for standalone
`.ts` and `.js` files. A `.vue` or `.svelte` file with a `<script>` block
yields the same exported symbols as a script file with the same code —
functions, classes, top-level constants, and the rest of the JS/TS symbol
set (see FR-1). This reuses the existing JS/TS extraction pipeline; it does
not add a second symbol pipeline.

**Non-exported functions in an embedded script (.vue, .svelte only).**
A Vue `<script setup>` block, and its Svelte equivalent, has no `export`
syntax. Every top-level declaration in the block is already the component's
public surface, read directly by the template. The indexer treats a
function-shaped top-level declaration in an embedded script as a symbol
even when it has no `export` keyword — a plain `function name() {}`, or a
`const name = () => {}` / `const name = function () {}` assignment (see
FR-4). This applies only to the embedded-script path. A standalone `.ts` or
`.js` file keeps the export-only rule in FR-1: an unexported helper there is
still not a symbol. A non-exported top-level constant with a literal value
(FR-1) is indexed the same way as before, in both a standalone script and
an embedded one. A non-exported constant whose value is neither a literal
nor a function shape — for example a composable call like `ref(false)` — is
still not indexed, in either case.

**Text-state fallback.** A `.vue` or `.svelte` file with no inline script,
or whose extracted script fails to parse, gets a `code_file_state` row and
one `kind=file` symbol. This is the same text-only treatment the indexer
gives any unsupported extension, so a template-only file is never dropped.

**Astro and the Svelte typo alias.** `.astro` files, and files with the
`.svlete` extension (a legacy typo alias for `.svelte`), always get
text-state indexing. The indexer does not attempt script extraction for
them.

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Tree-sitter indexer parses ASTs and indexes code symbols with source text (no structural edge facts in v1) |
| FR-2 | Parses inline `<script>` blocks in .vue/.svelte files through the JS/TS grammar and indexes their exported symbols |
| FR-3 | [UPDATED] Falls back to text-state indexing plus one `kind=file` symbol for .vue/.svelte with no parseable inline script, and always for .astro and the .svlete alias |
| FR-4 | Indexes a non-exported top-level function or function-valued constant in an embedded .vue/.svelte script, without extending that rule to standalone .ts/.js files |
| FR-5 | [UPDATED] Text-only allowlist files write one `kind=file` code_symbol; content-hash skip requires searchable rows so legacy state-only indexes heal on rescan; parse failures also emit a file-level symbol |
| FR-6 | [NEW] Emits a `kind=component` symbol named after the file basename for each .vue/.svelte file that has an embedded script |
| FR-7 | [NEW] Emits a `kind=file` symbol when parse succeeds but yields no symbols; indexes build-manifest extensions (`.cabal`, `.gradle`) as file-level symbols |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-QXNY | FR-1 | indexes exported functions and types | pass |
| TC-RH8M | FR-1 | indexes exported methods | pass |
| TC-ASLD | FR-1 | indexes exported constants and variables | pass |
| TC-P4LY | FR-1 | does not emit structural import edges (v1 indexes symbols only) | pass |
| TC-DRVZ | FR-1 | does not emit IMPORTS_FILE edges for unresolvable Go module paths | pass |
| TC-ANJ4 | FR-1 | skips unchanged files on re-index | pass |
| TC-11O9 | FR-1 | indexes exported classes and functions | pass |
| TC-3FNF | FR-1 | indexes exported interfaces and type aliases | pass |
| TC-954G | FR-1 | does not emit IMPORTS_FILE facts (v1 indexes symbols only) | pass |
| TC-0X92 | FR-1 | indexes exported components and functions from .tsx files | pass |
| TC-2EDD | FR-1 | indexes functions and classes | pass |
| TC-YBB8 | FR-1 | indexes functions and structs | pass |
| TC-5QN9 | FR-1 | indexes elements with id attributes | pass |
| TC-ATAZ | FR-5 | [UPDATED] creates code_file_state plus a file-level code_symbol for text-only files | pass |
| TC-UPJ4 | FR-1 | ignores unknown extensions not in the allowlist | pass |
| TC-ROFO | FR-1 | indexes code and text files together in one pass | pass |
| TC-YUE1 | FR-1 | does not emit EXTENDS/IMPLEMENTS structural facts (v1 symbols only) | pass |
| TC-0JE8 | FR-1 | stores source_text for exported constants with literal initializers | pass |
| TC-HAEK | FR-1 | indexes top-level non-exported constants with literal values as symbols | pass |
| TC-AX0K | FR-1 | indexes only the files passed as candidateFiles | pass |
| TC-M54E | FR-1 | finds exported symbols matching query terms via FTS (CodeGraphStore) | pass |
| TC-VJA3 | FR-1 | getSummary returns symbol and file counts (CodeGraphStore) | pass |
| TC-ESY9 | FR-1 | indexes exported functions from .jsx files | pass |
| TC-T083 | FR-2 | indexes exported symbols from .vue/.svelte inline script blocks | pass |
| TC-FBSK | FR-3 | falls back to text-state for .vue/.svelte with no inline script, and for Astro/typo aliases | pass |
| TC-VUEF | FR-4 | indexes non-exported top-level functions and function-valued constants from .vue/.svelte script setup blocks | pass |
| TC-VUEN | FR-4 | does not extend non-exported function capture to plain .ts/.js modules | pass |
| TC-F234 | FR-5 | [NEW] indexes `share/completions/scp.fish` as a searchable file-level symbol | pass |
| TC-H234 | FR-5 | [NEW] re-index after wiping symbols but keeping matching content_hash state | emits `kind=file` symbol again; skipped stays 0 |
| TC-SFC1 | FR-6 | [NEW] `Gantt.vue` / `Sidebar.svelte` with an embedded script | `kind=component` symbols named `Gantt` and `Sidebar`; not `Gantt.vue` |
| TC-ZSYM | FR-7 | [NEW] a file that parses cleanly but exports nothing | one `kind=file` symbol so the path stays searchable |
| TC-MANIFEST | FR-7 | [NEW] `Demo.cabal` with no AST grammar | indexed as a `kind=file` symbol |

### Related docs

- [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md)
