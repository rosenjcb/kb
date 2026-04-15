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

- Applied hybrid/vector-capable retrieval logic across intent surfaces where it makes sense: explain now uses id-first with semantic fallback (auto mode), validate/dispute results now include retrieval metadata visibility, and formatter keeps direct Answer + Retrieval in human output. (source: implementation)

- Intent command responses now use LLM-driven answer synthesis for read_documents paths (query/explain): CLI enriches read_documents results with provider-generated answer text and falls back to heuristic extraction only on provider failure or disable flag. (source: implementation)

- Created ticket 067 for kb chat interactive CLI session mode, updated linear backlog index, and branched to feat/067-kb-chat-cli-session-mode from main. (source: planning)

- Ticket 067 SPIKE closed with user-selected Option 1 (prompt/system-driven kb chat loop); context-rot hardening explicitly deferred by user; created follow-up tickets 068 (REPL), 069 (session controls/transcripts), and 070 (validation/context-rot mitigation). (source: planning)

- Ticket 068 implementation plan added: initial kb chat prototype prioritized (Option 1), includes per-turn evidence grounding and retrieval mode/provenance output, with advanced controls/context-rot deferred to tickets 069/070. (source: planning)

- Ticket 068 prototype implemented: added kb chat REPL command with per-turn read_documents grounding, LLM answers, retrieval mode/detail + sources output, and stable /exit/Ctrl+C handling; validated with focused tests, type-check, and runtime smoke. (source: implementation)

- Chat usefulness hardening shipped in current merge scope: upgraded shared markdown reader ranking for all read_documents consumers, added keyword broadening retry, and added chat workspace fallback evidence (README/GAMEPLAN) for broad project-purpose questions when KB hits are sparse or ticket-only; validated with tests + type-check + smoke chat run. (source: implementation)

- Created ticket 071 to plan retrieval decision checkpoints and miss-learning loop across all read_documents consumers (chat and intent/tool paths), with escalation stages, miss schema, rollout safety, and validation criteria; updated linear backlog index counts and links. (source: planning)

- Created and switched to feature branch feat/071-retrieval-decision-checkpoints-miss-learning with ticket 071/index/session-log changes in working tree; ready for implementation/build instructions. (source: planning)

- Closed SPIKE ticket 071 with implementation plan: defined deterministic retrieval checkpoint stages, miss-learning schema, and rollout/evaluation strategy; created follow-up implementation tickets 072, 073, and 074 before closure per phase-clarity policy; updated backlog index counts and links. (source: planning)

- Started ticket 072 implementation: added shared retrieval checkpoint orchestrator with deterministic stages and stop/go decisions, wired stage trace metadata into markdown reader query responses, and surfaced checkpoint traces in chat + intent human output; added orchestrator/reader/chat/intent tests and validated with focused passing suites plus type-check. (source: implementation)

- Implemented ticket 073 core miss-learning runtime: added sqlite schema/tables for retrieval_miss_events and retrieval_ranking_hints, added indexer APIs for recording miss events/listing miss clusters/reading ranking hints, integrated markdown reader with flag-gated miss capture and flag-gated ranking-hint boosts for hybrid ranking, and added tests for schema persistence + guardrails; focused suites and type-check passing. (source: implementation)

- Implemented ticket 074 rollout guardrails and observability: added retrieval_checkpoint_events schema, per-stage metrics API, promote/hold/rollback evaluator with explicit thresholds, reader checkpoint persistence path, and executable evaluation tests for promotion/rollback + stage observability. (source: implementation)

- Patched chat fallback policy for broad project-overview prompts: low-signal source detection now forces workspace fallback augmentation, added low-confidence recovery retry path, and preserved checkpoint trace metadata through fallback responses; validated via chat-cli tests + type-check + live kb chat dogfood run. (source: implementation)

- README dogfood checkpoint: added KB overview, base precedence order, and daily workflow guidance into general-facts for retrieval context. (source: readme)

- Decision checkpoint: keep checkpoint + miss-learning control plane as shipped in this branch; defer typed lane indexing and reconciliation-weighted ranking design to follow-up planning ticket. (source: decision)

- Prepared next task as ticket 075 (typed-lane indexing + runtime relevance routing), created feature branch feat/075-typed-lane-indexing-runtime-routing, and moved current unstaged main changes into this branch; environment verified and ready for build instructions. (source: planning)

- Closed SPIKE ticket 075 with planning-only implementation plan: defined typed-lane taxonomy, runtime lane-routing policy, and lane-aware ranking priorities with low title influence; created follow-up implementation tickets 076, 077, and 078 and updated backlog index counts/links. (source: planning)

- Started ticket 076 implementation: added typed retrieval lane taxonomy, persisted lane metadata in documents/chunks with migration-safe column backfill, implemented deterministic lane classifier and backfillDocumentLanes API, and added sqlite tests for lane persistence and backfill behavior; type-check and focused tests passing. (source: implementation)

- Implemented tickets 077 and 078: added shared runtime lane router and lane-fitness weighting in reader; lane-filtered hybrid candidates with controlled lane broadening fallback; lane-routing metadata surfaced in retrieval outputs; added retrieval_lane_routing_events schema plus lane-level metrics and rollout assessment APIs; added tests for lane selection, mixed-vs-lane-routed fixture precision, and lane guardrail rollback logic; validated with type-check and focused suites (reader/sqlite/chat) all passing. (source: consumer)

- Knowledge gap identified: CLI users are unclear how to validate lane-routing behavior in practice. Canonical dogfood flow: (1) KB_BASE=dogfood kb chat for default lane-routed behavior, (2) run same prompt with KB_LANE_ROUTING_ENABLED=false for A/B, (3) use kb query --output json to compare retrieval detail/checkpoints/lane-routing metadata, and (4) compare broad project vs operational incident prompts to verify different routed lane sets. (source: consumer)

- Documentation gap closure: added canonical CLI usage quick-reference with help/base-selection/core intents/chat/A-B retrieval checks so operators can run kb without reading source code. (source: consumer)

- Documentation checkpoint: added canonical CLI usage guidance and A/B retrieval toggle instructions into dogfood facts for discoverability. (source: consumer)

- Retrieval policy update: structured/organized stores are now queried first, with session-log lane treated as last-resort fallback for general queries; explicit change-diff/history queries route directly to session-log lane. Also fixed hybrid response metadata preservation so lane-routing details are not overwritten at the top-level response. (source: consumer)

- Planning checkpoint: created ticket 079 for fact-wide reconciliation/global rewrite propagation (exclude session-log by default, index-assisted candidate discovery with crawl fallback, deterministic reconciliation report), and created branch feat/079-fact-reconciliation-propagation from main for implementation. (source: consumer)

- Implemented ticket 079: added submit-driven fact-wide reconciliation with --replace-from/--replace-to, default session-log exclusion, optional include-session-logs and dry-run flags, index-assisted candidate prioritization with full-crawl fallback, deterministic reconciliation report, and focused passing tests across intent parser/router and specialized document operations. (source: consumer)

- Dogfood validation for ticket 079 reconciliation: refreshed global CLI, dry-run and live submit with --replace-from/--replace-to both returned reconcile_facts report; session-log remained skipped by default; index-assisted+full-crawl discovery reported deterministic counts; post-run query showed only replacement token in non-session docs. (source: consumer)

- Cross-tool evidence policy updated: validate now runs shallow->deep promotion on empty or inconclusive shallow evidence, query/explain auto-enable high-recall deep routing for exact-token lookups, and chat enforces exact-token fallback matching with explicit actionable guidance when grounded evidence is missing; dogfood verified with CONSISTENCY_TOKEN_20260412_VALIDATE_DEEP_PROMOTION across query/validate/explain/chat. (source: implementation)

- Drafted ticket 080 for Notion publish flow: package markdown to zip, import to Archive staging, and run two-pass Notion AI restructure/quality prompts with provenance and rollback safeguards. (source: planning)

- Ticket 080 decision: Notion is default provider for kb publish in v1, and kb notion publish compatibility alias is explicitly out of scope until separately implemented. (source: decision)

- Closed ticket 080 as SPIKE planning with user decisions captured (semi-automated + two-pass + fixed archive default with override). Created ticket 081 to implement kb publish Notion runtime with config-backed credentials and phase orchestration. (source: planning)

- Implemented v1 kb publish integration: added top-level kb publish command with package/import/restructure phases, JSON-config Notion auth support (from ~/.kb/config.json with env fallback), zip artifact + manifest generation, Notion staging import path for apply mode, and operator prompt-pack output for Notion AI restructure. (source: implementation)

- Updated tickets 080/081 to remove explicit kb notion publish references; plan now consistently refers to kb publish as the single v1 command surface. (source: docs-sync)

- kb publish --apply failed with Notion 404 object_not_found for parent page 340c0829-0aac-806b-a611-d4274498ddc5; Notion API indicates the page is not visible to integration 'Test'. Next step: share target parent page with the integration or set parentPageId to a page already shared. (source: verification)

- Attempted root-level Notion publish for kb publish; Notion API rejects workspace-root page creation for internal integrations. Added explicit actionable error message instructing use of notion.parentPageId. (source: implementation)

- Publish runtime checkpoint: kb publish now formats the wiki in-house and sends markdown directly to Notion's markdown page API instead of invoking the local agent loop during import. The runtime now creates a dedicated stage page, nests a Raw Import child page for as-is markdown imports, generates sibling wiki pages from deterministic local grouping/summarization, updates Notion API usage to the markdown docs version (2026-03-11), and validates that restructure-only apply runs include --stage-page-id. Focused publish tests now cover dry-run, stage-page validation, and mocked Notion apply behavior for raw-import plus generated wiki markdown pages. (source: consumer)

- Notion publish run completed from the live dogfood base using kb publish --base dogfood --phase all --apply. Result: 25 markdown documents imported under Raw Import and 6 reorganized wiki pages created under the stage page. Artifact: .tmp/notion-publish/dogfood-2026-04-13-211406.zip with sha256 bd0de8efc5584bdf9cf703808ccd094526c07aa0199c6092941fa10b48909b04. Stage page URL: https://app.notion.com/p/dogfood-Publish-2026-04-13-21-14-342c08290aac81efb980f4a8b56c53dc. Raw import page URL: https://app.notion.com/p/Raw-Import-342c08290aac8163aa0bdbc7f401ea3e. (source: consumer)

- Regenerated Notion publish completed after switching the wiki authoring flow to four total model passes and removing citation-heavy output. Result: 25 markdown docs imported and 6 reorganized wiki pages created. Stage page URL: https://www.notion.so/dogfood-Publish-2026-04-13-21-41-342c08290aac81c8bb97dfbe6311b975. Raw import page URL: https://app.notion.com/p/Raw-Import-342c08290aac81e08dbed4ddf7560c2d. Artifact: .tmp/notion-publish/dogfood-2026-04-13-214126.zip with sha256 155c02f13151ece4a66f2711725bc92c01c6b796fb7b1cbbf88a1918f35d4ebc. (source: consumer)

- Publish telemetry checkpoint: the richer-input Notion publish completed successfully and now records timing data for the authoring loop. Latest stage page: https://www.notion.so/dogfood-Publish-2026-04-13-22-01-342c08290aac813191ecf8229bd44107. Timings: importMs=15932, rawImportMs=13203, readInputsMs=31, pass1Ms=43556, pass2Ms=79081, pass3Ms=49576, pass4Ms=182149, wikiWriteMs=8927, restructureMs=363368. Root-cause fix applied before this run: wiki authoring now reads README.md and selected src/cli, src/tools, and src/core files in addition to dogfood markdown docs, instead of relying only on KB doc summaries/headings. (source: consumer)

- Publish runtime now supports progress-style stderr updates plus persisted checkpoint/resume behavior. kb publish writes a default checkpoint file under .tmp/notion-publish/<base>-latest.checkpoint.json, accepts --checkpoint-file to override, accepts --resume-from to continue from a saved checkpoint, and accepts --stop-after package|import|pass1|pass2|pass3|pass4|wiki-write to intentionally pause after a step. The restructure loop now checkpoints each model pass so failures or manual stop points can resume without rerunning completed passes. CLI help examples were updated and focused publish CLI tests now cover parser flags plus stop-after/resume behavior. (source: consumer)

- Fresh Notion publish run completed with updated heading-humanization and JSON-repair logic. Stage page URL: https://www.notion.so/dogfood-Publish-2026-04-14-19-12-343c08290aac8165950cfd390007c2f4. Raw import page URL: https://www.notion.so/Raw-Import-343c08290aac817a89a9c261e79c9089. Artifact: .tmp/notion-publish/dogfood-2026-04-14-191243.zip with sha256 1776ecf6ce9a17e06dc695c5f3cbded53573a3bc3c04ff460877c7d9b0382364. Timings: importMs=13617, rawImportMs=11786, pass1Ms=35950, pass2Ms=64903, pass3Ms=56949, pass4Ms=56296, wikiWriteMs=4359, restructureMs=288230. This run used a fresh checkpoint file: .tmp/notion-publish/dogfood-fresh-2026-04-14.checkpoint.json. (source: consumer)

- Ticket 081 closed: kb publish Notion runtime fully implemented in src/cli/publish-cli.ts. Architecture: parsePublishCommand() → runPublishCommand() → buildPublishArtifact() (zip+sha256 manifest) → importToNotion() (stage page + Raw Import child) → buildWikiSectionsWithIterations() (4-pass Claude loop: outline, draft, refine, polish) → writeWikiPagesToNotion() (Notion markdown API 2026-03-11). Phase flags: package|import|restructure|all. Credential resolution from ~/.kb/config.json notion.token/parentPageId with env fallback. Checkpoint/resume via --checkpoint-file, --resume-from, --stop-after. finalizeSectionOutlines() merges LLM pass1 outline against 6 canonical defaults (Overview, Getting Started, System Architecture, Retrieval & Data Handling, Policies & Decisions, Project History) using regex matching; uniqueStrings() deduplicates merged keyword/question arrays. Latest prompting constraint: pass2 requires Overview page explaining product and problem solved; Getting Started must cover day-one CLI usage not just config precedence. Live dogfood verified: 25 docs imported, 6 wiki pages created per run, typical total ~5-6 minutes. (source: implementation) (source: consumer)

- finalizeSectionOutlines() behavior: always merges LLM pass1 outline against hardcoded defaults instead of falling back only when empty. For each of 6 default sections, fuzzy-matches a pass1 section via regex (title+description+keywords haystack). On match: keeps default title, prefers pass1 description/problemFocus, unions keyQuestions (cap 6) and keywords (cap 10) via uniqueStrings(). Unmatched pass1 sections: up to 2 extras appended if !looksMachineNamed(title). uniqueStrings() = Array.from(new Set(values.map(v=>v.trim()).filter(Boolean))). New default section added: 'Retrieval & Data Handling' covering storage/merge/index/sqlite/document/search docs. Architecture section renamed to 'System Architecture'. Location: src/cli/publish-cli.ts. (source: implementation) (source: consumer)
