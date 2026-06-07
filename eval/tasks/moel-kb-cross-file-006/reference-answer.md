The data flow from `kb init` to a fact appearing in `read_facts` results spans 5 checkpointed
init cycles and several SQLite tables.

**Init cycles (in order):**
1. `read-inputs` — discovers all files in the repository and builds the file manifest.
2. `code-index` — runs both `TsMorphIndexer` (src/tools/code-graph-indexer.ts) for TypeScript/
   JavaScript code-graph relationships and `TreeSitterIndexer` (src/tools/tree-sitter-indexer.ts)
   for 17 languages. Both write facts with `source_kind='import_code'` into the `facts` table and
   update `code_file_state` with content hashes for incremental-rescan tracking.
3. `document-facts` — processes markdown and other text files via sentence segmentation, writing
   facts with `source_kind='doc'` into the `facts` table.
4. `import-docs` — processes imported documentation sources.
5. `write` — final flush of all staged facts, computes embeddings into `fact_embeddings`, builds
   the FTS5 virtual table `facts_fts`, assigns categories into `fact_categories` (via TF-IDF
   cosine similarity interview or auto-assignment), and writes `fact_edges` for the code graph.

**SQLite tables written:**
- `facts` — primary fact store (subject, predicate, object, fact_text, source_kind, etc.)
- `fact_edges` — code-graph relationships (IMPORTS_FILE, EXPORTS_SYMBOL edges)
- `facts_fts` — FTS5 virtual table over `fact_text` and `subject`/`object` fields
- `fact_embeddings` — semantic vector embeddings per fact
- `documents` — processed document records
- `fact_categories` — TF-IDF category assignments per fact
- `code_file_state` — content-hash snapshots for incremental rescan

`read_facts` queries the same `.kb-index.sqlite` database that `kb init` writes. It is not a
separate service — it runs a SQLite SELECT against the `facts` table, with hybrid FTS + semantic
scoring applied at query time.
