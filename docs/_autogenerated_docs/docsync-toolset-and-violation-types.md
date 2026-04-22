---
layout: default
title: DocSync Toolset and Violation Types
date: '2026-04-21'
kb_id: docsync-toolset-and-violation-types
tags:
  - docsync
  - tools
  - violations
categories:
  - reference
---

DocSync includes tools like `docsync_check`, `docsync_document`, and `docsync_audit` for checking, updating, and auditing documentation against code. Violations types include `undocumented_export`, `signature_mismatch`, `stale_description`, and `missing_section`.

- Dogfood graph was extended with manual kb graph edge adds (all with --base dogfood): knowledge-base stores_documents_in sqlite and stores_graph_in duckdb; kb-init runs_cycle pass-graph; pass-graph materializes_entities_into duckdb; kb-graph drives graph-expansion; graph-expansion augments kb-query; graph-aware-hybrid-retrieval blends_with semantic-search; markdown-document-reader reads_index_from sqlite; kb-query retrieves_via markdown-document-reader; duckgraph-writer depends_on duckdb; kb-submit triggers graph-extraction; graph-extraction upserts_into duckdb; kb-invalidate updates_documents_in sqlite and soft_deletes_edges_in duckdb. (source: consumer)
