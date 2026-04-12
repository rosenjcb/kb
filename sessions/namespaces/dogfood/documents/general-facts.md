# general facts

Created: 2026-04-12T17:15:59.959Z
Type: reference
Tags: general, fact

- SQLite hybrid search enabled for this workspace (source: setup)

- SQLite index probe write to confirm db creation (source: verification)

- SQLite index probe via local runner (source: verification)

- SQLite index probe via refreshed global kb (source: verification)

- sqlite probe (source: verification)

- Vector retrieval architecture: (1) Markdown documents remain source of truth. (2) SqliteKbIndexer stores derived index tables: documents, chunks, chunks_fts, chunk_embeddings, index_state. (3) Writer operations write_document, append_to_document, update_document, prune_document, and merge_documents(target) trigger index sync when KB_SQLITE_INDEX=true. (4) Query path in MarkdownDocumentReader uses hybrid retrieval when KB_HYBRID_QUERY=true: FTS candidate prefilter + vector rerank, with lexical fallback when hybrid is unavailable or latency budget is exceeded. (5) Intent surfaces using read_documents include query_truth and explain_change (auto mode id-first + semantic fallback), while validate/dispute evaluators also call read_documents in content mode. (source: implementation)
