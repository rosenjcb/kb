---
layout: default
title: Agent Workflow and Requirements
date: '2026-04-21'
kb_id: agent-workflow-and-requirements
tags:
  - agents
  - workflow
  - requirements
categories:
  - policy
---

Agents must ensure CLI access is fresh with `npm run refresh:global` and use KB docs during execution. Work must be documented in KB against the dogfood base, and changes must be committed and pushed to Git as part of completion.

- SubmitOrchestrator (src/tools/submit-orchestrator.ts) is the new agent behind kb submit. Discovery-first: shallow read_documents probe on the fact text; if retrieval.method is hybrid and results exist, appends to the top matched doc. Fallback: if no hybrid match, infers domain via regex and upserts into domain-facts. Mirrors the QueryResearchOrchestrator composition pattern (intent command → orchestrator → tools). inferDomainFromFact extracted from router.ts into submit-orchestrator.ts. router.ts submit_fact now returns selectedOperation: submit_orchestrator. (source: consumer)

