---
layout: default
title: cicd facts
date: '2026-04-21'
kb_id: cicd-facts
tags:
  - cicd
  - fact
categories:
  - reference
---

- QueryResearchOrchestrator (src/tools/query-research-orchestrator.ts) is activated when discoveryDepth is 'deep' in read_documents calls. It replaces the old linear checkpoint pipeline for deep queries with a hypothesis-driven research loop: seed 3-5 search hypotheses (original, title-pass, broad, graph-slugs, keyword), probe in parallel (3 concurrent), read headings from top docs, spawn child hypotheses from pseudo-relevance feedback, and iterate up to 3 times. Coverage is scored as 0.4 * topScore + 0.3 * agreementFraction + 0.2 * noveltyFraction; threshold to stop early is 0.60 with at least 2 docs seen. Final assembly uses MMR-style deduplication (skip docs sharing >50% heading overlap with already-selected docs). Falls back to exhaustive search if coverage never reaches threshold. RESEARCH_MAX_MS is 3000ms. Replaces the old count-based estimateConfidence and simple query_rewrite_retry. MarkdownDocumentReader delegates to it at the top of queryDocuments() when discoveryDepth === 'deep'. Observable via retrieval_runs and retrieval_hypotheses SQLite tables (migration version 4). (source: consumer)

- kb chat (src/cli/chat-cli.ts) no longer has internal retry or recovery logic. It delegates all retrieval depth and fallback to QueryResearchOrchestrator by always passing discoveryDepth: 'deep' to read_documents. One execute call, one LLM call per turn. This follows the composition principle: feature (chat) -> agent flow (orchestrator) -> tools (probeHybrid, probeLexical, etc). The old looksLikeInsufficientEvidenceAnswer, buildRecoveryQuery, mergeReadResults and related retry helpers have been deleted. Future evolution: chat will become an intent classifier that dispatches to kb query, kb submit, kb invalidate etc rather than calling tools directly - see src/core/CHAT.md for the full vision. (source: consumer)

- Orchestrator subagent harness (src/core/agent-loop.ts): the main orchestrator now spawns typed subagents for parallelizable work. The research subagent profile is restricted to read_documents only and runs through agentLoop with delegated tool calls. This prevents the executor from blending planning, searching, and judging in a single loop. Doc merging was added to kb submit flow: when submitting new content, the writer now merges with the existing target document rather than overwriting. kb publish now targets Jekyll/Vitepress via GitHub Actions Pages deploy (jekyll-vitepress-theme); the publish command writes docs to a git-tracked sessions/ output and triggers the workflow. (source: consumer)

- SubmitOrchestrator (src/tools/submit-orchestrator.ts) is the new agent behind kb submit. It runs a two-phase loop: (1) discovery — shallow read_documents probe on the fact text, if retrieval.method is 'hybrid' and results exist, appends to the top matched doc; (2) fallback — if no hybrid match, infers domain via regex (cicd/security/infra/observability/retrieval/general) and upserts into domain-facts. Mirrors the QueryResearchOrchestrator pattern: the same composition principle (intent command → orchestrator → tools) now applies to both kb query and kb submit. Domain inference logic (inferDomainFromFact) was extracted from router.ts into submit-orchestrator.ts. DefaultIntentRouter.route() for submit_fact now returns selectedOperation: submit_orchestrator instead of submit_orchestrator. (source: consumer)
