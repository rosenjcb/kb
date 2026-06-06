# TICKET-002: AST Structural Loss (`L_AST`)

**Status:** Open  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, correctness

## Context

One half of the correctness loss is structural: does the agent's output have the right syntactic shape? LLM judges are unreliable at catching missing interfaces, wrong function signatures, and malformed class hierarchies.

`web-tree-sitter` (v0.26.8 in `package.json`) with WASM grammars is already in the project. The following grammar packages are direct dependencies in `package.json` and each ships a `.wasm` file resolved via `require.resolve()`:

| Language key | npm package | WASM file |
|---|---|---|
| `ts` | `tree-sitter-typescript` v0.23.2 | `tree-sitter-typescript.wasm` |
| `tsx` | `tree-sitter-typescript` v0.23.2 | `tree-sitter-tsx.wasm` |
| `python` | `tree-sitter-python` v0.25.0 | `tree-sitter-python.wasm` |
| `js` / `jsx` | `tree-sitter-javascript` v0.25.0 | `tree-sitter-javascript.wasm` |
| `go` | `tree-sitter-go` v0.25.0 | `tree-sitter-go.wasm` |
| `rust` | `tree-sitter-rust` v0.24.0 | `tree-sitter-rust.wasm` |
| `java` | `tree-sitter-java` v0.23.5 | `tree-sitter-java.wasm` |
| `ruby` | `tree-sitter-ruby` v0.23.1 | `tree-sitter-ruby.wasm` |
| `c` | `tree-sitter-c` v0.24.1 | `tree-sitter-c.wasm` |
| `cpp` | `tree-sitter-cpp` v0.23.4 | `tree-sitter-cpp.wasm` |
| `csharp` | `tree-sitter-c-sharp` v0.23.5 | `tree-sitter-c_sharp.wasm` |
| `bash` | `tree-sitter-bash` v0.25.1 | `tree-sitter-bash.wasm` |
| `php` | `tree-sitter-php` v0.24.2 | `tree-sitter-php_only.wasm` |
| `scala` | `tree-sitter-scala` v0.24.0 | `tree-sitter-scala.wasm` |
| `css` | `tree-sitter-css` v0.25.0 | `tree-sitter-css.wasm` |
| `html` | `tree-sitter-html` v0.23.2 | `tree-sitter-html.wasm` |

`src/tools/tree-sitter-indexer.ts` already initializes the WASM runtime and loads languages. The AST loss function reuses this exact pattern — no new dependencies, no Python.

## Objective

Implement `computeAstLoss(candidate: string, reference: string, language: string, parser: Parser): Promise<number>` in TypeScript using the existing `web-tree-sitter` infrastructure. Returns a normalized loss in `[0, 1]` where `0` is a perfect structural match.

The `parser` argument receives an already-initialized `Parser` instance (see "Initialization Pattern" below) so WASM is not reloaded on every call.

## Acceptance Criteria

- [ ] Reuses the two-step WASM initialization from `src/tools/tree-sitter-indexer.ts` — do not re-implement it (see "Initialization Pattern" below).
- [ ] Node set for a document is derived from the `exportQueries` patterns already defined in `LANG_CONFIGS` in `tree-sitter-indexer.ts` — specifically, the `@name` capture that identifies a named declaration within each node type. See "Node Types by Language" below for the full list per language.
- [ ] Node key format: `"{nodeType}:{name}"` where `nodeType` is the tree-sitter node type of the `@name` capture's parent declaration node (e.g., `"function_definition:computeLoss"`, `"class_declaration:MyClass"`). This mirrors how the indexer uses `nameNode.type` for the captured `@name` node text.
- [ ] Structural distance is Jaccard: `L_AST = 1 - |N(candidate) ∩ N(reference)| / |N(candidate) ∪ N(reference)|`
- [ ] Returns `1.0` if either input fails to parse (i.e., `parser.parse()` throws or returns `null`).
- [ ] Supports all 16 languages in `LANG_CONFIGS` at minimum; TypeScript and Python are the P0 cases.
- [ ] Unit tests cover: identical inputs → `0.0`, completely different inputs → `1.0`, one missing function → partial loss, parse failure → `1.0`.

## Initialization Pattern

In `src/tools/tree-sitter-indexer.ts`, the `TreeSitterIndexer` class initializes the runtime in two separate async steps, both guarded by existence checks:

**Step 1 — initialize the WASM engine** (`ensureParser`, called once per indexer instance):
```ts
// src/tools/tree-sitter-indexer.ts, lines 554-558
private async ensureParser(): Promise<void> {
  if (this.parser) return
  await Parser.init()          // static method on web-tree-sitter Parser class
  this.parser = new Parser()
}
```

**Step 2 — load a language grammar** (`ensureLang`, called once per language key, results cached in `this.langCache: Map<string, CompiledLang>`):
```ts
// src/tools/tree-sitter-indexer.ts, lines 560-572
private async ensureLang(key: string): Promise<void> {
  if (this.langCache.has(key)) return
  const config = LANG_CONFIGS[key]
  if (!config) throw new Error(`No config for language: ${key}`)
  const language = await Language.load(config.wasmPath)  // async WASM load
  const compiled: CompiledLang = {
    language,
    importQueries: config.importQueries.map(s => new Query(language, s)),
    exportQueries: config.exportQueries.map(s => new Query(language, s)),
    config,
  }
  this.langCache.set(key, compiled)
}
```

**Step 3 — parse and set language** (synchronous, done per-file inside `indexFile`):
```ts
// src/tools/tree-sitter-indexer.ts, lines 462-465
parser.setLanguage(compiled.language)
tree = parser.parse(src)
```

WASM file paths are resolved using Node's `createRequire(import.meta.url)` and `require.resolve()`:
```ts
// src/tools/tree-sitter-indexer.ts, lines 29, 54-56
const require = createRequire(import.meta.url)

function resolveWasm(pkg: string, file: string): string {
  return require.resolve(`${pkg}/${file}`)
}
```

**For `computeAstLoss`:** expose a factory or module-level singleton that calls `Parser.init()` + `new Parser()` once, caches loaded `Language` objects keyed by language string, then accepts an already-initialized `Parser` + `Language` as arguments to the pure computation. This avoids any WASM reload per call. The recommended signature:

```ts
// eval/losses/ast-loss.ts

import { Parser, Language, Query } from 'web-tree-sitter'
import { createRequire } from 'node:module'

// Call once at module initialization or via an explicit init function:
export async function initAstLossParser(): Promise<AstLossParser> { ... }

// AstLossParser holds: parser: Parser, langCache: Map<string, Language>
export async function computeAstLoss(
  candidate: string,
  reference: string,
  language: string,   // key matching LANG_CONFIGS, e.g. 'ts', 'python'
  ctx: AstLossParser
): Promise<number> { ... }
```

## Node Types by Language

The `exportQueries` in `LANG_CONFIGS` define exactly which named declarations are extracted. The `@name` capture identifies the identifier node; its parent (or the `getDeclNode` walk-up) gives the declaration node type. The following table lists the declaration node types per language key as they appear in `LANG_CONFIGS`:

**TypeScript (`ts` / `tsx`)** — uses `export_statement` wrapper; inner declaration types:
- `class_declaration` (name: `type_identifier`)
- `function_declaration` (name: `identifier`)
- `lexical_declaration` → `variable_declarator` (name: `identifier`)
- `interface_declaration` (name: `type_identifier`)
- `type_alias_declaration` (name: `type_identifier`)
- `abstract_class_declaration` (name: `type_identifier`)
- `enum_declaration` (name: `identifier`) — `ts` only

**Python (`python`)**:
- `function_definition` (name: `identifier`)
- `class_definition` (name: `identifier`)

**JavaScript (`js` / `jsx`)**:
- `class_declaration` (name: `identifier`)
- `function_declaration` (name: `identifier`)
- `lexical_declaration` → `variable_declarator` (name: `identifier`)

**Go (`go`)**:
- `function_declaration` (name: `identifier`)
- `method_declaration` (name: `field_identifier`)
- `type_declaration` → `type_spec` (name: `type_identifier`)
- `var_declaration` → `var_spec` (name: `identifier`)
- `const_declaration` → `const_spec` (name: `identifier`)

**Rust (`rust`)**:
- `function_item` (name: `identifier`)
- `struct_item` (name: `type_identifier`)
- `enum_item` (name: `type_identifier`)
- `trait_item` (name: `type_identifier`)
- `type_item` (name: `type_identifier`)
- `const_item` (name: `identifier`)
- `mod_item` (name: `identifier`)

**Java (`java`)**:
- `class_declaration`, `interface_declaration`, `enum_declaration`, `method_declaration`, `constructor_declaration` (all name: `identifier`)

**Ruby (`ruby`)**:
- `method` (name: `identifier`)
- `singleton_method` (name: `identifier`)
- `class` (name: `constant`)
- `module` (name: `constant`)

**C (`c`)**: `function_definition`, `declaration`, `type_definition`, `struct_specifier`, `enum_specifier`

**C++ (`cpp`)**: `function_definition`, `declaration`, `class_specifier`, `struct_specifier`, `enum_specifier`

**C# (`csharp`)**: `class_declaration`, `interface_declaration`, `struct_declaration`, `enum_declaration`, `method_declaration`, `constructor_declaration`

**Bash (`bash`)**: `function_definition` (name: `word`)

**PHP (`php`)**: `function_definition`, `class_declaration`, `interface_declaration`, `trait_declaration`, `method_declaration`

**Scala (`scala`)**: `function_definition`, `function_declaration`, `class_definition`, `object_definition`, `trait_definition`, `val_definition`

For the Jaccard set, use the `@name` capture text combined with its containing declaration node type as the key: `"{declarationNodeType}:{nameText}"`. The declaration node type is the `type` field on the parent of the captured `@name` node (i.e., what `getDeclNode` walks up to in the indexer). For TypeScript specifically, this is the inner declaration inside the `export_statement`, not the `export_statement` node itself.

## Snippet Wrapping

For snippets rather than full files, wrap in a minimal valid module before parsing:

- **TypeScript / JavaScript**: prepend `export {};\n` — top-level statements require a module context for the TS grammar's `export_statement` queries to fire.
- **Python**: no wrapper needed; top-level statements are valid at the module root.
- **Go**: wrap in `package main\n` if no `package` declaration is present.
- All other languages: attempt to parse as-is; return `1.0` if parse fails.

## Files to Create

- `eval/losses/ast-loss.ts`

## Files to Reference (do not modify)

- `src/tools/tree-sitter-indexer.ts` — `LANG_CONFIGS`, `resolveWasm`, `ensureParser`, `ensureLang`, `EXT_MAP`, `CompiledLang` interface, `getDeclNode` helper, imports from `web-tree-sitter`: `{ Parser, Language, Query }` and `type { Tree }`

## Dependencies

TICKET-001 (for integration context, not for implementation)

## Feeds Into

TICKET-006 (MOEL Aggregator)
