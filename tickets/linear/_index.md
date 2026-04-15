# KB + DocSync Linear Ticket Backlog

This folder contains discrete ticket drafts as one markdown file per ticket.

## Planned Themes

- Foundation and contracts
- Local markdown KB flows
- MCP server scaffolding
- Notion backend integration
- Sync intelligence and audits
- Reliability, observability, and release

## Summary

- Total files: 83 (82 tickets + this index)
- Branch: feat/kb-ticket-backlog

## Foundation

- [001 Define KB mission and scope](tickets/linear/001-kb-mission-and-scope.md)
- [002 Freeze DocumentWriter contract v1](tickets/linear/002-contract-document-writer-v1.md)
- [003 Freeze violation schema contract v1](tickets/linear/003-contract-violation-schema-v1.md)
- [004 Freeze tool invocation envelope v1](tickets/linear/004-contract-tool-invocation-v1.md)
- [005 Define error taxonomy and retry policy](tickets/linear/005-error-taxonomy-and-retry-policy.md)
- [006 Define environment loading policy](tickets/linear/006-environment-loading-policy.md)
- [037 Define model provider selection policy](tickets/linear/037-model-provider-selection-policy.md)

## Local KB

- [007 Specify markdown storage layout](tickets/linear/007-markdown-storage-layout-spec.md)
- [008 Specify markdown naming and collision policy](tickets/linear/008-markdown-file-naming-collision-policy.md)
- [009 Specify tiny table index format](tickets/linear/009-markdown-index-table-spec.md)
- [010 Define session lifecycle and persistence rules](tickets/linear/010-session-lifecycle-spec.md)
- [011 Define decision log schema and categories](tickets/linear/011-decision-log-schema-spec.md)
- [012 Specify CLI create document flow](tickets/linear/012-cli-create-document-flow-spec.md)
- [013 Specify CLI update document flow](tickets/linear/013-cli-update-document-flow-spec.md)
- [014 Specify single file check flow](tickets/linear/014-cli-check-single-file-flow-spec.md)
- [015 Create local smoke test checklist](tickets/linear/015-local-smoke-test-checklist.md)
- [047 Design document operation semantics and merging strategy](tickets/linear/047-document-operation-semantics-and-merging.md)
- [048 Implement write_document tool v2](tickets/linear/048-implement-write-document-tool-v2.md)
- [049 Implement append_to_document tool](tickets/linear/049-implement-append-to-document-tool.md)
- [050 Implement update_document tool](tickets/linear/050-implement-update-document-tool.md)
- [051 Implement merge_documents tool](tickets/linear/051-implement-merge-documents-tool.md)
- [052 Implement prune_document tool](tickets/linear/052-implement-prune-document-tool.md)
- [053 Wire specialized tools registry and test matrix](tickets/linear/053-specialized-tools-registry-and-test-matrix.md)
- [054 Define consumer-intent API contract](tickets/linear/054-consumer-intent-api-contract.md)
- [055 Define intent router and internal-tool boundary](tickets/linear/055-intent-router-and-internal-tool-boundary.md)
- [056 Specify fact validation and dispute contract](tickets/linear/056-fact-validation-and-dispute-contract.md)
- [057 Specify consumer CLI intent UX and command set](tickets/linear/057-consumer-cli-intent-ux-and-commands.md)
- [058 Implement consumer-intent API and IntentRouter runtime](tickets/linear/058-implement-consumer-intent-api-and-router.md)
- [059 Implement intent-first CLI commands](tickets/linear/059-implement-intent-first-cli-commands.md)
- [062 Add CLI base-selection commands for KB context](tickets/linear/062-cli-base-selection-commands.md)
- [067 Add kb chat interactive CLI session mode](tickets/linear/067-kb-chat-cli-session-mode.md)
- [068 Implement kb chat interactive REPL command](tickets/linear/068-implement-kb-chat-repl-command.md)
- [069 Add chat session controls and transcript persistence](tickets/linear/069-chat-session-controls-and-transcript-persistence.md)
- [039 Define permission policy evaluation order](tickets/linear/039-permission-policy-evaluation-order.md)
- [040 Define document ID stability rules](tickets/linear/040-kb-doc-id-stability-rules.md)

## MCP

- [016 Bootstrap MCP server skeleton](tickets/linear/016-mcp-server-bootstrap.md)
- [017 Add MCP transport and tool registration plan](tickets/linear/017-mcp-transport-and-tool-registration.md)
- [018 Specify docsync_check MCP tool contract](tickets/linear/018-mcp-tool-docsync-check-spec.md)
- [019 Specify docsync_document MCP tool contract](tickets/linear/019-mcp-tool-docsync-document-spec.md)
- [020 Specify docsync_audit MCP tool contract](tickets/linear/020-mcp-tool-docsync-audit-spec.md)
- [021 Define MCP error mapping strategy](tickets/linear/021-mcp-error-mapping-spec.md)
- [038 Specify docsync.toml configuration contract](tickets/linear/038-docsync-config-file-spec.md)

## Notion

- [022 Define Notion backend adapter interface](tickets/linear/022-notion-backend-interface-spec.md)
- [023 Define file to Notion page identity mapping](tickets/linear/023-notion-page-identity-mapping-spec.md)
- [024 Define Notion source of truth conflict rules](tickets/linear/024-notion-source-of-truth-rules.md)
- [025 Define Notion rate limit and backoff behavior](tickets/linear/025-notion-rate-limit-backoff-plan.md)
- [026 Write Notion auth and access runbook](tickets/linear/026-notion-auth-and-page-access-runbook.md)
- [043 Define markdown and Notion coexistence mode](tickets/linear/043-notion-markdown-coexistence-mode.md)
- [080 Publish markdown KB to Notion with AI workspace restructuring flow](tickets/linear/080-publish-markdown-kb-to-notion-with-ai-restructure-flow.md)
- [081 Implement `kb publish` Notion runtime](tickets/linear/081-implement-kb-publish-notion-runtime.md)
- [082 SQLite-exclusive document storage and `kb init` bootstrap command](tickets/linear/082-sqlite-exclusive-storage-and-kb-init-command.md)

## Intelligence

- [027 Define compare prompt and JSON schema](tickets/linear/027-compare-prompt-and-json-schema.md)
- [028 Define violation normalization rules](tickets/linear/028-violation-normalization-rules.md)
- [029 Define evaluation plan for single file check](tickets/linear/029-single-file-check-evaluation-plan.md)
- [030 Define directory audit scan boundaries](tickets/linear/030-directory-audit-scan-boundaries.md)
- [031 Define coverage metric for audits](tickets/linear/031-coverage-metric-definition.md)
- [032 Define audit report output schema](tickets/linear/032-audit-report-shape-spec.md)
- [041 Define check caching strategy](tickets/linear/041-docsync-check-caching-strategy.md)
- [042 Define audit parallelism and token budgets](tickets/linear/042-audit-parallelism-and-budgeting.md)
- [046 Define validation vs deep_validation tool semantics](tickets/linear/046-validation-vs-deep-validation-tool-semantics.md)
- [060 Implement fact validation and dispute evaluator](tickets/linear/060-implement-fact-validation-and-dispute-evaluator.md)
- [063 Add SQLite vector search index for KB query retrieval](tickets/linear/063-sqlite-vector-search-index-for-kb-query.md)
- [064 Implement SQLite index schema and document indexer](tickets/linear/064-implement-sqlite-index-schema-and-indexer.md)
- [065 Implement hybrid FTS + vector query runtime](tickets/linear/065-implement-hybrid-fts-vector-query-runtime.md)
- [071 Add retrieval decision checkpoints and miss-learning loop across tool surfaces](tickets/linear/071-retrieval-decision-checkpoints-and-miss-learning-loop.md)
- [072 Implement retrieval decision-checkpoint orchestrator across read_documents consumers](tickets/linear/072-implement-retrieval-decision-checkpoint-orchestrator.md)
- [073 Implement retrieval miss-learning schema and feedback loop](tickets/linear/073-implement-retrieval-miss-learning-schema-and-feedback-loop.md)
- [075 Implement typed-lane indexing and runtime relevance-routed retrieval](tickets/linear/075-typed-lane-indexing-and-runtime-relevance-routing.md)
- [076 Implement retrieval lane schema and index migration](tickets/linear/076-implement-lane-schema-and-index-migration.md)
- [077 Implement runtime lane router and lane-aware retrieval pipeline](tickets/linear/077-implement-runtime-lane-router-and-lane-aware-retrieval.md)
- [079 Implement fact-wide reconciliation and global rewrite propagation](tickets/linear/079-implement-fact-wide-reconciliation-and-global-rewrite-propagation.md)

## Reliability

- [033 Define observability event catalog](tickets/linear/033-observability-event-catalog.md)
- [034 Write provider failure handling playbook](tickets/linear/034-provider-failure-handling-playbook.md)
- [035 Define contract test matrix plan](tickets/linear/035-contract-test-matrix-plan.md)
- [036 Create release readiness checklist](tickets/linear/036-release-readiness-checklist.md)
- [044 Write operational incident response runbook](tickets/linear/044-incident-response-runbook.md)
- [045 Define schema/version migration policy](tickets/linear/045-versioning-and-migration-policy.md)
- [061 Enforce internal tool access policy for consumer-facing flows](tickets/linear/061-enforce-internal-tool-access-policy.md)
- [066 Add tests, rollout controls, and latency guardrails for hybrid search](tickets/linear/066-test-rollout-and-latency-guardrails-for-hybrid-search.md)
- [070 Validate kb chat mode and harden context-rot handling](tickets/linear/070-chat-mode-validation-and-context-rot-hardening.md)
- [074 Add retrieval checkpoint evaluation and rollout guardrails](tickets/linear/074-add-retrieval-checkpoint-evaluation-and-rollout-guardrails.md)
- [078 Add lane-routing evaluation fixtures and rollout guardrails](tickets/linear/078-add-lane-routing-evaluation-fixtures-and-rollout-guardrails.md)

