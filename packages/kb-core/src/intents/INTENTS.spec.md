---
type: Spec
title: "Spec: Intent Routing"
sources: [./]
tests: [../../../../tests/intents]
description: Behavioral specification for Intent Routing
tags: [spec, kb]
timestamp: 2026-08-16T00:15:00Z
---

### Intro

Behavioral requirements. Architecture: [INTENTS.md](INTENTS.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Behaviors in router.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-Z1H5 | FR-1 | Given query_truth without discoveryDepth, then defaults to deep discovery like chat | pass |
| TC-GTAJ | FR-1 | Given query_truth with high-recall token query, then uses default limit without floor | pass |
| TC-AX85 | FR-1 | Given query_truth without explicit limit, then defaults to DEFAULT_FACT_LIMIT facts | pass |
| TC-HZOB | FR-1 | Given a collector on the constructor, then query_truth operationInput carries it through | pass |
| TC-XH9F | FR-1 | Given a read_facts result with no checkpoints, then evidence reflects the actual result count instead of a hardcoded strong | pass |
| TC-1YYY | FR-1 | Given a read_facts result with zero results and no checkpoints, then evidence is none, not strong | pass |

### Related docs

- [INTENTS.md](INTENTS.md)

