# TICKET-009: Programmatic Validation (Manifest & Mutation Checks)

**Status:** Open  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, validation, testing

## Context

LLM jury scores are probabilistic. Two programmatic checks provide a hard, contamination-resistant correctness floor:

1. **Manifest Check** — the agent must declare every file it modified. The harness verifies the declaration matches the actual git diff.
2. **Mutation Check** — agent-modified code must pass the test suite against the real repo, and fail when targeted dependencies are stubbed out. This confirms tests are active and causally linked to the agent's changes.

The test runner is Vitest. The exact command (from `package.json`) is:

```
NODE_OPTIONS=--no-warnings vitest run
```

invoked via `npm run test`. There is no `--timeout` flag wired into the script; timeout for the mutation runner must be handled by the `MutationValidator` itself using `child_process` options (e.g. `AbortController` + `{ signal, timeout }` on `execFile`/`spawn`), not by a Vitest CLI flag.

The mutation check patches TypeScript source files using the existing `web-tree-sitter` infrastructure (already in the project) to replace function bodies with `throw new Error("moel-stub")` without touching function signatures.

## Objective

Implement `ManifestValidator` and `MutationValidator` as TypeScript classes in `eval/validators/`.

## Acceptance Criteria

### ManifestValidator
- [ ] `validate(manifest: string[], repoPath: string): Promise<ManifestResult>` diffs declared files against `git diff --name-only HEAD` output.
- [ ] Returns: `{ passed: boolean; declared: string[]; actual: string[]; undeclaredChanges: string[]; phantomDeclarations: string[] }`.
- [ ] Passes only if `undeclaredChanges` is empty. Phantom declarations are a warning, not a failure.
- [ ] Manifest is extracted from the agent's final message as a JSON block with key `"manifest"`.
- [ ] Unit tests: exact match, missing file in manifest, extra file in manifest, empty manifest with no changes.

### MutationValidator
- [ ] `run(repoPath: string, targetSymbols: string[], testTimeout: number): Promise<MutationResult>` does:
  1. Run `npm run test` in `repoPath` — must pass (`baselinePassed: true`).
  2. For each target symbol, use `web-tree-sitter` to find and replace its body with `throw new Error("moel-stub")` in a git worktree copy.
  3. Run `npm run test` in the worktree — must fail (`mutantFailed: true`).
- [ ] Returns: `{ baselinePassed: boolean; mutantFailed: boolean; valid: boolean; perSymbol: Record<string, boolean> }`.
- [ ] Mutation is applied in a `git worktree add` temporary directory, not in-place.
- [ ] Worktree is cleaned up (`git worktree remove --force`) on completion or error.
- [ ] If test run exceeds `testTimeout` (default 60s), marks as `timedOut: true`, not failed.
- [ ] Unit tests: correct change (baseline pass + mutant fail = valid), trivially passing tests (both pass = invalid), broken change (baseline fail = invalid).

## Implementation Notes

### Manifest Extraction

The agent is prompted (in the harness system prompt) to include a manifest block in its final message:

```json
{ "manifest": { "modified": [...], "created": [...], "deleted": [...] } }
```

The validator concatenates `modified`, `created`, and `deleted` into a flat list and compares against `git diff`.

### Mutation Patching via tree-sitter

#### WASM Initialization

Copy the exact two-step init from `src/tools/tree-sitter-indexer.ts`:

```typescript
// Step 1 — call once before any parsing (idempotent after first call)
await Parser.init()
const parser = new Parser()

// Step 2 — load the grammar for the target file extension
const language = await Language.load(wasmPath)
parser.setLanguage(language)
```

The WASM path for TypeScript files is resolved at module load time via:

```typescript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const wasmPath = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')
// For .tsx files:
const tsxWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm')
```

Do not hardcode paths — `require.resolve` is the correct pattern used throughout the indexer.

#### Tree-sitter Node Types for TypeScript Body Replacement

The relevant node type hierarchy for TypeScript/TSX (confirmed from `LANG_CONFIGS.ts` export queries):

| Construct | Declaration node type | Name child type | Body child type |
|---|---|---|---|
| Exported top-level function | `function_declaration` | `identifier` | `statement_block` |
| Class method | `method_definition` | `property_identifier` | `statement_block` |
| Arrow function (variable) | `arrow_function` | (no name — walk from variable_declarator) | `statement_block` |

**Critical:** The `export_statement` wraps `function_declaration` for exported functions. The `statement_block` is always the body child — it is the curly-brace block `{ ... }`. Replace only the `statement_block`, not the full declaration node, so the signature is preserved verbatim.

#### Byte-Offset Replacement Pattern

The indexer uses `node.startIndex` / `node.endIndex` (byte offsets into the UTF-8 source string) here:

```typescript
const rawText = src.slice(declNode.startIndex, declNode.endIndex)
```

Use the same offsets to perform a surgical replacement. Walk the tree after parsing, find the target function by name match, locate its `statement_block` child, then splice:

```typescript
const src = readFileSync(filePath, 'utf8')
const tree = parser.parse(src)

// Walk to find the statement_block of the target function
function findBody(node: TsNode, symbolName: string): TsNode | null {
  // Match function_declaration or method_definition whose name child text === symbolName
  if (
    (node.type === 'function_declaration' || node.type === 'method_definition') &&
    node.childForFieldName('name')?.text === symbolName
  ) {
    return node.childForFieldName('body') ?? null  // 'body' field → statement_block
  }
  for (let i = 0; i < node.childCount; i++) {
    const result = findBody(node.child(i)!, symbolName)
    if (result) return result
  }
  return null
}

const bodyNode = findBody(tree.rootNode, symbolName)
if (!bodyNode) throw new Error(`Symbol not found: ${symbolName}`)

const stub = '{ throw new Error("moel-stub"); }'
const patched =
  src.slice(0, bodyNode.startIndex) +
  stub +
  src.slice(bodyNode.endIndex)

writeFileSync(filePath, patched, 'utf8')
```

**Gotcha — `childForFieldName('body')` vs manual child walk:** The `web-tree-sitter` `Node` API exposes `childForFieldName(name)` which is the correct way to get named grammar fields. Do not search by `node.type === 'statement_block'` among children if you can use the field name — it is more robust across grammar versions. The field name for the function body is `body` in both `function_declaration` and `method_definition` tree-sitter grammars for TypeScript.

**Gotcha — `arrow_function` bodies:** Arrow functions whose body is an expression (no braces) have a non-`statement_block` body child. For the mutation validator, only target symbols that have a `statement_block` body; skip expression-body arrows or convert them: wrap with `{ throw new Error("moel-stub"); }` replacing the entire expression body.

**Gotcha — Parser.init() is async and must complete before `new Parser()`:** The indexer calls `await Parser.init()` inside `ensureParser()`, guarded by a null check. In the mutation validator, replicate this guard — cache the initialized parser across calls within one `MutationValidator` instance.

### Test Command (Exact)

From `package.json` `"scripts"`:

```
"test": "NODE_OPTIONS=--no-warnings vitest run"
```

When spawning this in the validator, use:

```typescript
execFile('npm', ['run', 'test'], {
  cwd: worktreePath,
  timeout: testTimeoutMs,
  env: { ...process.env },
})
```

`NODE_OPTIONS=--no-warnings` suppresses Node.js experimental-feature warnings that would otherwise contaminate stdout/stderr parsing. The `vitest.config.ts` configures `include: ['tests/**/*.test.ts']`, `globals: true`, `restoreMocks: true`, `clearMocks: true` — no per-test timeout is set in the config, so Vitest uses its internal default (5 000 ms per test). The mutation validator's `testTimeout` parameter controls the wall-clock budget for the whole `npm run test` subprocess, not individual test timeouts.

### Git Worktree Command Sequence

```bash
# 1. Create worktree at a temp path (use mkdtemp for the parent, then name the worktree dir)
#    --detach avoids creating/polluting a new branch
git -C <repoPath> worktree add --detach <worktreePath>

# 2. Apply the mutation patch to <worktreePath>/<targetFile>

# 3. Run the test suite
npm run test   # cwd = <worktreePath>

# 4. Cleanup — always in a finally block
git -C <repoPath> worktree remove --force <worktreePath>
# Also rm -rf the temp dir if mkdtemp created a parent that worktree add didn't claim
```

**Exact flags:**
- `git worktree add --detach <path>` — checks out HEAD detached; no branch is created.
- `git worktree remove --force <path>` — removes the worktree registration and the checkout directory even if the worktree has local modifications (the mutation patch counts as a modification, so `--force` is required).
- Run both `git` commands with `-C <repoPath>` so the cwd of the Node process does not matter.

**Gotcha — worktree path must not already exist:** `git worktree add` fails if the target directory exists. Use `os.mkdtemp()` to get a unique parent temp directory, then pass `path.join(tmpDir, 'worktree')` as the worktree path so the leaf does not pre-exist.

**Gotcha — shared object store:** The worktree shares `.git` with the original repo. Do not run `git init` or `git clone` — `git worktree add` is the only correct setup step.

**Gotcha — `npm run test` in the worktree needs `node_modules`:** The worktree checkout will contain the source files but `node_modules` is not a tracked file. Since the worktree shares the working tree layout, `node_modules` will be present at `<worktreePath>/node_modules` only if there is a symlink or if the package manager was run there. For this validator, assume the worktree operates against the same `node_modules` as the original repo by running `npm run test` from the worktree root — npm will walk up to find `package.json` and the local `node_modules`. Verify this assumption holds in the target repo before shipping.

### Vitest Import Pattern (for test files)

Test files in this repo import from vitest using named imports, not globals (despite `globals: true` in config):

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
```

Use the same pattern in the new test files under `tests/` or `eval/validators/`.

## Files to Create

- `eval/validators/manifest-validator.ts`
- `eval/validators/mutation-validator.ts`

## Files to Reference (do not modify)

- `src/tools/tree-sitter-indexer.ts` — WASM initialization pattern (`ensureParser`, `ensureLang`, `createRequire`-based wasm path resolution, `node.startIndex`/`node.endIndex` usage at line 507)

## Dependencies

TICKET-001 (for integration with trajectory logging)

## Feeds Into

TICKET-010
