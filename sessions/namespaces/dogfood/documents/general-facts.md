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

- README: KB is a local-first knowledge system for AI workflows with intent-first CLI commands (submit/query/validate/dispute) and optional SQLite hybrid retrieval (FTS + vector-style ranking) that falls back to lexical query when unavailable. (source: readme)

- README precedence: effective KB base resolution order is 1) kb use session base, 2) kb default saved base, 3) KB_BASE environment fallback. (source: readme)

- README workflow: keep KB docs close to code and checkpoint durable knowledge via git add sessions/, commit, and push. (source: readme)

- CLI testing fact: Lane-routing verification should be done with an on/off A/B using KB_LANE_ROUTING_ENABLED and identical prompts, then compared via retrieval metadata in kb chat or kb query --output json. (source: consumer)

- CLI quick-reference: kb --help; kb use dogfood; kb default dogfood; kb submit/query/validate/dispute/explain with --output json; KB_BASE=dogfood kb chat for interactive mode; use KB_LANE_ROUTING_ENABLED=false for retrieval A/B checks. (source: consumer)


- Rollout strategy is immediate. (source: consumer)

- FINAL_CONSISTENCY_CHECKPOINT_20260412 (source: consumer)
