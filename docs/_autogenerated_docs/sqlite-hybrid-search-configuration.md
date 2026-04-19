---
layout: default
title: SQLite Hybrid Search Configuration
date: '2026-04-18'
kb_id: sqlite-hybrid-search-configuration
tags:
  - sqlite
  - hybrid-search
  - configuration
categories:
  - reference
---

Enable SQLite hybrid search by setting `KB_SQLITE_INDEX` and `KB_HYBRID_QUERY` to true in `.env.local`. Optional tuning parameters include `KB_HYBRID_QUERY_CANDIDATES`, `KB_HYBRID_QUERY_ALPHA`, and `KB_HYBRID_QUERY_MAX_MS` to adjust search behavior and performance.

- Ticket 082 retrieval fix checkpoint: default-general-signals and project-overview queries now broaden fallback lanes to include error-runbook, which restores SQLite hybrid hits for install/setup docs like installation-and-configuration. Verified with source CLI query 'how do i install kb' against base dogfood, returning installation-and-configuration via hybrid retrieval with lane-router detail policy,error-runbook and lane-broadened. (source: consumer)

- Ticket 082 end-to-end checkpoint: restored lexical reader compatibility by falling back to markdown files when SQLite is unavailable, fixed sqlite document upserts to persist full documents.content for lexical-fallback recovery, cleaned current TypeScript build breaks in init-cli and sqlite-document-writer, and added explicit install/setup lane routing so built CLI query 'how do i install kb' now returns installation-and-configuration first from base dogfood after kb init resume/apply. (source: consumer)
