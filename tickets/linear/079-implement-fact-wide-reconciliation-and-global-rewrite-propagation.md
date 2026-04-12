# Implement fact-wide reconciliation and global rewrite propagation

## Ticket ID
079

## Theme
intelligence

## Problem
Submitting a new corrective fact (for example, renaming a canonical term) does not reconcile older facts, so stale references continue to appear and compete during retrieval.

## Scope
- Add reconciliation flow that can replace outdated fact references across existing KB documents.
- Exclude session-log lane from automatic replacement by default.
- Use retrieval index (hybrid/vector + lexical) to find candidate documents for replacement, with full crawl fallback for deterministic coverage.
- Persist reconciliation provenance and changed-document summaries for auditability.

## Acceptance Criteria
- Submitting a corrective fact can trigger a reconciliation pass that updates matching references in non-session-log documents.
- Session-log documents are untouched unless explicitly opted in.
- Candidate discovery can run via index-assisted search and fallback crawl mode.
- Reconciliation run returns deterministic report: scanned docs, changed docs, skipped docs, and replacement counts.
- Tests cover positive replacement, exclusion policy, and no-op/idempotent reruns.

## Dependencies
060
065
076
077

## Deliverables
- Reconciliation tool/API contract and router wiring.
- Document rewrite implementation with lane-aware exclusions.
- Audit/report schema and regression tests.

## Estimate
L

## Priority
High

---

## Implementation Plan

### Fact-Wide Reconciliation With Session-Log Exclusion By Default

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Defined reconciliation contract and routing behavior
	- Defined exclusion policy and discovery strategy
- ✅ Phase 2 (Implementation): Complete in this ticket
	- Added reconciliation tool and submit-flow wiring
	- Added deterministic replacement behavior and tests

#### Background
Submitting a corrective fact previously appended new truth without reconciling stale references. This allowed outdated terms to persist and compete in retrieval.

#### Approach
Implemented a new `reconcile_facts` operation and wired it into `submit_fact` when replacement arguments are provided. Reconciliation performs index-assisted candidate discovery when SQLite FTS is available and always applies full-crawl fallback for deterministic coverage. Session-log documents are excluded by default, with explicit opt-in support. Reconciliation returns a deterministic audit report with scanned/changed/skipped counts and document IDs.

#### Examples / Specifications

Submit with reconciliation:

```bash
kb submit "Canonical identifier renamed" \
	--replace-from foo \
	--replace-to bar
```

Submit with session-log inclusion and dry run:

```bash
kb submit "Canonical identifier renamed" \
	--replace-from foo \
	--replace-to bar \
	--include-session-logs \
	--dry-run-reconcile
```

Reconciliation report shape:

```ts
interface ReconcileFactsResult {
	replaceFrom: string
	replaceTo: string
	dryRun: boolean
	scannedDocs: number
	changedDocs: number
	skippedDocs: number
	totalReplacements: number
	changedDocumentIds: string[]
	skippedDocumentIds: string[]
	discovery: {
		strategy: 'index-assisted+full-crawl' | 'full-crawl'
		indexCandidateCount: number
	}
}
```

#### Error Conditions / Edge Cases
- Missing replacement pair: `replaceFrom` and `replaceTo` must both be present.
- No-op replacement (`replaceFrom === replaceTo`): returns deterministic zero-change report.
- Missing SQLite index: reconciliation falls back to full crawl.
- Session-log exclusion: default skip unless `includeSessionLogs=true`.
- Dry run mode: computes counts and candidate IDs without writing files.

#### Decisions Made
- ✅ Decided: Reconciliation is opt-in via submit replacement arguments, not always-on. -> Rationale: avoids unsafe broad rewrites for normal fact submission.
- ✅ Decided: Session logs are excluded by default. -> Rationale: preserve historical transcripts unless explicitly requested.
- ✅ Decided: Discovery uses index-assisted candidate prioritization plus full-crawl fallback. -> Rationale: keeps deterministic correctness while leveraging index speed when available.
- ✅ Decided: Reconciliation report includes document IDs and counts. -> Rationale: supports auditability and downstream tooling.

#### Integration Points
- `src/cli/intent-cli.ts`: submit parser supports `--replace-from`, `--replace-to`, `--include-session-logs`, `--dry-run-reconcile`.
- `src/intents/router.ts`: submit execution triggers `reconcile_facts` after append/write when replacement pair is present.
- `src/tools/kb-tools-registry.ts`: registers `reconcile_facts` operation.
- `src/tools/markdown-md-writer-tool.ts` and `src/tools/specialized-document-tools.ts`: reconciliation implementation and SQLite reindex sync.

#### Validation & Closure
This implementation establishes:
- ✅ Corrective fact submission can trigger fact-wide reconciliation updates.
- ✅ Session-log docs are excluded by default and only updated when explicitly enabled.
- ✅ Candidate discovery runs index-assisted when available and full-crawl for deterministic fallback.
- ✅ Reconciliation returns deterministic counts and changed/skipped document IDs.
- ✅ Focused tests pass for CLI parsing, router execution, and specialized reconciliation behavior.

**Ticket 079 is now closed.**
