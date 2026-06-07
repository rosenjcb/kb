kb handles incremental rescans through content-hash comparison against the `code_file_state`
SQLite table. When `kb scan` is run (equivalent to `kb init --rescan --apply`), it:

1. **Reads current hashes:** For each source file, `getCodeFileState()` (src/tools/code-fact-
   writer.ts) queries `code_file_state` to retrieve the previously stored content hash.
2. **Compares hashes:** The current file content is hashed and compared. If the hash matches, the
   file is unchanged and skipped entirely — no re-indexing occurs. This is purely hash-based (not
   mtime, file size, or inode-based).
3. **Tombstones stale facts:** For files that have changed or been deleted, `tombstoneStaleCodeFacts()`
   marks all facts derived from that file as stale (setting a tombstone flag in the `facts` table).
   `tombstoneStaleAstFacts()` does the same for AST-level tree-sitter facts.
4. **Re-indexes changed files:** The changed files are re-processed by both `TsMorphIndexer` and
   `TreeSitterIndexer`. New facts are written and `upsertCodeFileState()` stores the new content
   hash in `code_file_state`.
5. **Re-assigns categories:** Any new or updated facts that lack category assignments are auto-
   assigned to existing categories using TF-IDF cosine similarity at threshold 0.3. No interactive
   interview is run (unlike the initial `kb init` flow). This is orchestrated by
   `RescanApplyOrchestrator` (src/tools/rescan-apply-orchestrator.ts).

The net result: only truly changed files are re-indexed, making rescans fast and proportional to
the number of changed files rather than the total repository size.
