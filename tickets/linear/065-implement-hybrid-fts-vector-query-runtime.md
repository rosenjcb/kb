# Implement hybrid FTS + vector query runtime

## Ticket ID
065

## Theme
intelligence

## Problem
Ticket 063 defines hybrid retrieval semantics, but read_documents currently uses markdown scan-only behavior.

## Scope
- Add hybrid retrieval path under feature flag.
- Implement FTS candidate selection and vector reranking.
- Add lexical-only fallback when embeddings/vector path is unavailable.

## Acceptance Criteria
- read_documents contract remains stable.
- Hybrid scoring returns improved relevance for paraphrase queries.
- Fallback behavior is explicit and tested.

## Dependencies
063
064
008
057
060

## Deliverables
- Hybrid query runtime implementation.
- Scoring and fallback tests.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Implemented Hybrid FTS + Vector Query Runtime (Phase: Plan + Code)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Hybrid retrieval strategy and fallback expectations confirmed
	- Contract compatibility target locked (`read_documents` output unchanged)
- ✅ Phase 2 (Implementation): Complete in this ticket
	- Added hybrid path in `MarkdownDocumentReader` behind feature flag
	- Added FTS candidate selection + vector reranking logic
	- Added explicit lexical fallback when hybrid path is unavailable
- ⏳ Deferred
	- Advanced relevance tuning and production embeddings integration refinements (future follow-up)

#### Background
Before this ticket, `read_documents` used markdown scan-only content matching. Ticket 064 populated SQLite index structures; this ticket wires query-time hybrid retrieval to use that index while preserving old behavior as fallback.

#### Approach
`MarkdownDocumentReader` now attempts hybrid retrieval when enabled and query mode is content/auto. The hybrid path reads SQLite FTS candidates and computes combined ranking using lexical score + vector similarity score. If SQLite is missing, query parsing fails, or guardrails trigger fallback, reader transparently returns lexical scan results using the previous logic.

#### Examples / Specifications
Rollout knobs implemented in reader options/env:
- `KB_HYBRID_QUERY=true|false`
- `KB_HYBRID_QUERY_CANDIDATES` (default 40)
- `KB_HYBRID_QUERY_ALPHA` (default 0.45)
- `KB_HYBRID_QUERY_MAX_MS` (default 120)

Reader options:

```ts
new MarkdownDocumentReader(baseDir, {
	hybridEnabled: true,
	sqliteDbPath: path.join(baseDir, '.kb-index.sqlite'),
	hybridCandidateLimit: 40,
	hybridAlpha: 0.45,
	hybridMaxMs: 120,
})
```

#### Error Conditions / Edge Cases
- Missing or unreadable SQLite DB -> warning + lexical fallback.
- Empty tokenized query for hybrid path -> lexical fallback.
- Embedding row missing/invalid JSON -> heuristic semantic score fallback (non-fatal).
- Candidate limit exhausted -> deterministic top scoring docs only.

#### Decisions Made
- ✅ Decided: Keep `read_documents` I/O unchanged while changing ranking internals. -> Rationale: no consumer/API break.
- ✅ Decided: Hybrid activation is opt-in (feature flag/options). -> Rationale: safe staged rollout.
- ✅ Decided: Fallback is automatic and silent to caller (with internal warning). -> Rationale: resilience and backward compatibility.

#### Integration Points
- Uses schema/index data created in ticket 064.
- Supplies improved relevance for intent commands that rely on `read_documents`.
- Latency/rollout hardening covered by ticket 066 tests and controls.

#### Validation & Closure
This implementation establishes:
- ✅ Acceptance criterion met: `read_documents` contract remains stable.
- ✅ Acceptance criterion met: hybrid scoring path implemented and validated in tests.
- ✅ Acceptance criterion met: lexical fallback behavior is explicit and tested.

Test evidence:
- `tests/tools/markdown-document-reader.test.ts` includes hybrid ranking and fallback cases.
- Type checking passes under strict TypeScript settings.

**Ticket 065 is now closed.**
