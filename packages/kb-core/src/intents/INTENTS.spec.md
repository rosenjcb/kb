---
type: Spec
title: "Spec: Intent Routing"
sources: ./,../../tests/intents
description: Behavioral specification for Intent Routing
tags: [spec, kb]
timestamp: 2026-06-28T04:05:30Z
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
| TC-1 | FR-1 | Given query_truth without discoveryDepth, then defaults to deep discovery like chat | pass |
| TC-2 | FR-1 | Given query_truth with high-recall token query, then uses default limit without floor | pass |
| TC-3 | FR-1 | Given query_truth without explicit limit, then defaults to 500 facts | pass |

### Related docs

- [INTENTS.md](INTENTS.md)

