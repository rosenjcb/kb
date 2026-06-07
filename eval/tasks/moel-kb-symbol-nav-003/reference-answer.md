`TreeSitterIndexer` (src/tools/tree-sitter-indexer.ts) is kb's multi-language AST indexer. It
uses `web-tree-sitter` (WASM) grammars to extract structured code graph facts from 17 languages
defined in the `LANG_CONFIGS` registry. The supported languages are: Go, TypeScript, TSX,
JavaScript, JSX, Python, Rust, Ruby, Java, C, C++ (.cpp), C# (.cs), CSS, Bash (.sh), PHP, Scala,
and HTML.

For each language, `LangConfig` specifies: `wasmPath` (path to the compiled grammar), `importQueries`
(S-expression queries that capture import relationships), `exportQueries` (S-expression queries
that capture exported symbol names), and optionally `goExportConvention` (a boolean). When
`goExportConvention` is true (only for Go), only identifiers whose first character is uppercase are
treated as exported — this matches Go's idiomatic exported-symbol convention rather than relying on
`export` keywords.

The indexer writes two kinds of facts into the `facts` table: `EXPORTS_SYMBOL` facts (recording
what each file exports) and `IMPORTS_FILE` facts (recording what each file imports from). When
files are deleted or their content changes, `tombstoneStaleAstFacts()` marks their previously
written facts as stale before reindexing.

Note: TypeScript is handled by both `TreeSitterIndexer` (for EXPORTS_SYMBOL/IMPORTS_FILE via tree-
sitter grammars) and `TsMorphIndexer` (src/tools/code-graph-indexer.ts, which uses the ts-morph
library for richer code-graph relationships). They operate independently and write different fact
kinds.
