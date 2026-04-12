# Session Log - April 12 2026

Created: 2026-04-12T13:56:24.315Z
Tags: session-log, history, dogfood

This document summarizes the working session on April 12, 2026, focusing on several key developments:

- **Tool-Registry Integration**: Implementation and testing of the tool-registry module to streamline tool operations within the system.
- **Document Reader Creation**: Development of a new document reader to enhance knowledge base interactions.
- **CLI Executable Build Strategy**: Updates and refinements to the build strategy for the CLI executable to ensure robust deployment.
- **Shell-Driven Test Harnesses**: Creation and deployment of shell-driven test harnesses to facilitate automated testing.
- **Namespace Isolation for Tests**: Enforcement of namespace isolation to maintain test environment integrity and prevent data leakage.
- **Persistence Policy Updates**: Revision of the persistence policies to align with current operational standards and requirements.
- **Cleanup of Old Functional-Test Documents**: Systematic removal of outdated and deprecated functional-test documents to maintain a clean and efficient documentation environment.

These components contribute significantly to the system's development and operational efficiency, ensuring a robust and scalable platform.

- Workspace policy updated: dogfood defaults to intent-first workflows. Agents should query existing docs first, then submit updates to existing targets, and use freeform only by explicit user request or intent-command limitations. This policy is now codified in AGENTS.md and spike-ticket-workflow skill guidance. (source: consumer)

- Fact check: We do not currently use SQLite as the KB document store. Current persistent store is local markdown documents under sessions/namespaces/<namespace>/documents (or sessions/documents by default). SQLite is only a potential future backend direction. (source: consumer)

- Ticket 062 SPIKE planning completed and closed: defined nvm-style CLI base selection commands (kb use <base>, kb default <base>), deterministic precedence order (override then env then persisted default then fallback), config shape, and error model while preserving KB_BASE_DIR compatibility. (source: consumer)

- CLI UX update: running kb with no args now prints a built-in help screen, and kb --help/-h shows the same usage guidance with intent command examples. (source: consumer)

- Migration complete: implemented kb use and kb default commands, switched storage selection to KB_BASE and KB_BASE_DIR precedence, removed KB_NAMESPACE references from source/tests/docs, and moved default fallback to sessions/namespaces/default/documents. (source: consumer)

- Decision update for ticket 062: keep ~/.kb/configuration.yml schema minimal for now (defaultBase and updatedAt), add future keys like API access references later, and treat .env.local as CI/CD-dependent override surface instead of primary local configuration. (source: consumer)

- Verification checkpoint 2026-04-12: Vitest suite passes after precedence refactor (9 files, 40 tests). (source: verification)

- Docs sync checkpoint: README now documents base resolution as session use -> saved default -> KB_BASE fallback, and CLI/tests were updated to match this exact order. (source: docs-sync)

- Correction (2026-04-12 code audit): CLI base resolution precedence is 1) config.sessionBase (kb use), 2) config.defaultBase (kb default), 3) env.KB_BASE fallback. If none are set, resolveEffectiveBaseDir throws an explicit error. Evidence: src/cli/base-selection.ts and src/cli/index.ts. (source: code-audit)

- Kickoff checkpoint: created ticket 063 (SQLite vector search index for KB query retrieval), updated tickets/linear/_index.md, and created branch feat/063-sqlite-vector-search-index for implementation. (source: planning)

- Ticket 063 SPIKE closed with implementation plan: decided v1 embedding strategy = Ollama local embeddings; created follow-up tickets 064 (SQLite schema/indexer), 065 (hybrid FTS+vector runtime), and 066 (tests/rollout guardrails); updated linear index accordingly. (source: planning)

- Ticket 064 implementation checkpoint: added SqliteKbIndexer schema bootstrap (documents/chunks/chunks_fts/chunk_embeddings/index_state), wired MarkdownMDWriterTool index sync on write/append/update/prune/merge(target), added content-hash stale detection API, and validated with sqlite-kb-index tests + type-check. (source: implementation)

- Tickets 065 and 066 completed: hybrid FTS+vector query runtime added behind rollout flags, explicit lexical fallback behavior implemented, latency guardrail enforcement added, and reliability tests expanded for hybrid/missing-index/budget fallback scenarios. (source: implementation)

- README updated with Getting Started with SQLite Hybrid Search section, including native dependency setup, KB_SQLITE_INDEX/KB_HYBRID_QUERY flags, tuning knobs, and verification flow with fallback behavior. (source: docs-sync)

- README was rewritten to a generalized onboarding guide: concise use case, quick start, provider setup, base selection, intent command examples, optional SQLite hybrid setup, daily workflow, and core dev commands. (source: docs-sync)

- README updated to .env.local-first onboarding: provider/base/hybrid flags now documented in .env.local with explicit local-context commands (dev:local/start:local). (source: docs-sync)

- Added explicit retrieval method telemetry in query responses: read_documents now returns retrieval metadata (hybrid|lexical|lexical-fallback + detail), and human formatter prints Retrieval line for visibility. (source: implementation)
