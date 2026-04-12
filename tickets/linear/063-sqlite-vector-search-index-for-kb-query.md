# Add SQLite vector search index for KB query retrieval

## Ticket ID
063

## Theme
intelligence

## Problem
The current KB query path scans markdown files linearly and uses substring/token overlap matching. As dogfood content grows, retrieval quality for paraphrased questions and query latency will degrade.

## Scope
- Define a SQLite-backed retrieval index that augments (not replaces) markdown source-of-truth documents.
- Specify hybrid retrieval behavior (FTS prefilter + vector reranking).
- Define index update triggers for write/append/update/prune/merge document operations.
- Define fallback behavior when vector index is unavailable or stale.

## Acceptance Criteria
- A clear and reviewable markdown spec exists.
- Request/response behavior for hybrid search is unambiguous.
- Index schema and refresh semantics are explicit.
- Failure and fallback behavior is explicit and testable.
- Rollout path is gated behind feature flags and is backward-compatible with current markdown query behavior.

## Dependencies
008
053
057
060

## Deliverables
- Final markdown spec in this file.
- Proposed SQLite schema for documents/chunks/embeddings.
- Handoff checklist for implementation and tests.

## Estimate
M

## Priority
High

---

## Implementation Plan

### SQLite Hybrid Retrieval Index for KB Query

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- SQLite index architecture and schema
	- Hybrid retrieval contract (FTS + vector rerank)
	- Index update/fallback semantics
	- Decision checkpoints documented
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
	- Add indexer + query runtime in src/tools
	- Add embeddings provider adapter and tests
	- Add CLI/feature-flag wiring and migration scripts
	- Blocking tickets: 064 (schema + indexer), 065 (hybrid query runtime), 066 (tests + rollout)

#### Background
Current retrieval in `src/tools/markdown-document-reader.ts` is file-scan based (`readdir` + per-file read + substring/token overlap). This is correct for small stores but will underperform for paraphrase-heavy queries and growing dogfood corpus size.

#### Approach
Retain markdown files as source-of-truth and add a SQLite retrieval index as a derived cache. Query flow becomes hybrid: lexical prefilter through FTS, then vector rerank on candidate chunks, then document-level aggregation with provenance. When indexing is unavailable, stale, or feature-flagged off, runtime must fall back to the current markdown reader to preserve backward compatibility and operational safety.

#### Examples / Specifications

1. Proposed SQLite schema (v1):

```sql
CREATE TABLE IF NOT EXISTS documents (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	file_path TEXT NOT NULL UNIQUE,
	doc_type TEXT,
	tags_json TEXT,
	content_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
	chunk_id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL,
	chunk_index INTEGER NOT NULL,
	heading_path TEXT,
	chunk_text TEXT NOT NULL,
	token_count INTEGER NOT NULL,
	FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
	UNIQUE (doc_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	chunk_id,
	doc_id,
	chunk_text,
	tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
	chunk_id TEXT PRIMARY KEY,
	model_id TEXT NOT NULL,
	dimensions INTEGER NOT NULL,
	vector_json TEXT NOT NULL,
	embedded_at TEXT NOT NULL,
	FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
```

2. Hybrid retrieval algorithm (v1):

```text
Input query
	-> lexical candidate fetch (FTS top N, default 40)
	-> embedding(query) and cosine similarity over candidates
	-> combined score = (alpha * lexical_score) + ((1 - alpha) * vector_score)
	-> doc-level aggregate by max chunk score + diversity bonus
	-> return top K docs with snippet + provenance chunk refs
```

3. Query tool I/O compatibility:

```json
{
	"input": {
		"query": "base precedence override behavior",
		"mode": "content",
		"limit": 5,
		"includeContent": true
	},
	"output": {
		"results": [
			{
				"metadata": {
					"id": "cli-facts",
					"title": "cli facts",
					"filePath": "...",
					"createdAt": "...",
					"updatedAt": "..."
				},
				"content": "..."
			}
		],
		"total": 5
	}
}
```

No public contract change in v1: `read_documents` remains the interface; only ranking/latency behavior changes under feature flag.

4. Index update triggers:
- `write_document`: upsert document + re-chunk + re-embed all chunks
- `append_to_document`: re-chunk + re-embed affected document
- `update_document`: re-chunk + re-embed affected document
- `prune_document`: re-chunk + re-embed affected document
- `merge_documents`: update target and remove/mark source as archived depending on merge policy

#### Error Conditions / Edge Cases
- SQLite unavailable/corrupt: log warning, hard fallback to markdown reader, return successful query response path.
- Embedding provider unavailable/rate-limited: execute lexical-only retrieval and mark vector status degraded in internal metadata.
- Dimension mismatch (stored vectors vs active model): invalidate and rebuild affected embeddings.
- Stale index (content hash mismatch): lazy reindex on read path with bounded budget; if budget exceeded, fallback to lexical-only for that request.
- Very large docs: chunk by heading boundaries first, then token window fallback to keep chunks bounded.

#### Decisions Made
- ✅ Decided: Markdown remains source-of-truth; SQLite is a derived retrieval index only. -> Rationale: keeps current persistence model and rollback safety.
- ✅ Decided: Keep `read_documents` public contract stable in v1. -> Rationale: avoids consumer breakage and isolates rollout risk.
- ✅ Decided: Hybrid retrieval starts with FTS prefilter then vector rerank. -> Rationale: lower cost than full-corpus vector scan.
- ❓ Open question: Embedding provider strategy for v1 index build/runtime. -> Time-box: decide before ticket 064 implementation starts.

#### User Decision Checkpoint (Required)
- Decision requested from user: Which embedding strategy should v1 use?
- Options presented:
	- A) OpenAI embeddings (recommended default for quality/consistency)
	- B) Ollama local embeddings (lower external dependency, variable quality)
	- C) Pluggable provider abstraction with OpenAI first implementation (higher upfront complexity)
	- D) Lexical-only in 064, defer embeddings to 065+ (lowest immediate scope)
- User response: B) Ollama local embeddings.
- Follow-up: Created ticket 064 (schema/indexer), 065 (hybrid runtime with Ollama embeddings path), and 066 (tests + rollout guardrails).

#### Integration Points
- Builds on ticket 008 query contract and ticket 053 specialized tools integration.
- Aligns with ticket 057 intent CLI UX and ticket 060 validation/dispute behavior by improving evidence retrieval quality.
- Planned follow-ups:
	- Ticket 064: SQLite schema + indexer wiring
	- Ticket 065: Hybrid read_documents runtime + scoring
	- Ticket 066: Test matrix (correctness, fallback, latency guardrails)

#### Validation & Closure
This implementation plan establishes:
- ✅ Acceptance criterion met: clear markdown spec with concrete architecture and schema.
- ✅ Acceptance criterion met: request/response and fallback behavior are explicit.
- ✅ Acceptance criterion met: index refresh/update semantics are documented.
- ✅ Acceptance criterion met: rollout remains feature-flagged and backward-compatible.
- ✅ Closure gate status: user selected embedding strategy for v1 (Ollama local embeddings).

Ticket 063 is now closed.
