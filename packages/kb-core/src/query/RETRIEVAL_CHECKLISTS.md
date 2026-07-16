---
type: Subsystem
title: Retrieval-time checklists
description: Doc-questionnaire coverage dimensions injected into decompose, sufficiency, and short-query expansion.
resource: ./retrieval-checklists.ts
tags: [query, retrieval, checklists]
timestamp: 2026-07-16T00:00:00Z
---

# Retrieval-time checklists

Type checklists for Reference / Decision / Howto / Runbook / Introduction live in
[`../prompts/doc-questionnaires/`](../prompts/doc-questionnaires/) and are loaded by
[`../core/doc-questionnaire.ts`](../core/doc-questionnaire.ts). Doc-gen uses them for
draft structure. Retrieval reuses the same lists so planning and sufficiency ask for the
right evidence shape earlier than synthesis.

## Flow

1. `classifyQueryDocType(query)` — cheap heuristic → `DocType` (no LLM).
2. `formatRetrievalChecklist(docType)` — questionnaire bullets, skip `documentTitle`.
3. Consumers inject `retrievalChecklistPromptBlock(query)`:
   - sufficiency judge (`facts-sufficiency-judge.ts`)
   - short-query expand (`query-expander.ts`)
   - chat decompose (`kb-client` `chat-cli.ts`)

## Related

- Spec → [`RETRIEVAL_CHECKLISTS.spec.md`](RETRIEVAL_CHECKLISTS.spec.md)
- [`../tools/FACT_CURATOR.md`](../tools/FACT_CURATOR.md) — curator does **not** own these lists
- [`../core/QUERY_INTERNALS.md`](../core/QUERY_INTERNALS.md) — deep query path
- [`../core/CHAT.md`](../core/CHAT.md) — decompose pre-step
