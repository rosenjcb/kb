---
type: Spec
title: "Spec: UI Primitives"
sources: ../ui,../../tests/ui
description: Behavioral specification for UI Primitives
tags: [spec, kb]
timestamp: 2026-06-28T04:05:31Z
---

### Intro

Behavioral requirements for this domain.

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
| FR-1 | Behaviors in orchestration-meta.test.ts |
| FR-2 | Behaviors in printer.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given human labels, then wire keys are lowercase slugs | pass |
| TC-2 | FR-1 | Given a line, then detects orchestration wire rows but not assistant stream | pass |
| TC-3 | FR-1 | Given label and value, then formats wire line | pass |
| TC-4 | FR-2 | Given tui mode, chat metadata keeps routing prefixes | pass |
| TC-5 | FR-2 | Given tui mode, separator routes as orchestration meta | pass |
| TC-6 | FR-2 | Given cli mode without tty, metadata uses orchestration wire lines | pass |
| TC-7 | FR-2 | Given a progress sink, transient progress and clear route to it (not the transcript) | pass |
| TC-8 | FR-2 | Given no progress sink in tui mode, progress is dropped (no transcript spam) | pass |
| TC-9 | FR-2 | condenseProgressText folds whitespace and tail-truncates to the latest text | pass |
| TC-10 | FR-2 | createReasoningProgressSink accumulates deltas and pushes the running tail | pass |

### Related docs



