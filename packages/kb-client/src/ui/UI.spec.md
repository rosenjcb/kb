---
type: Spec
title: "Spec: UI Primitives"
sources: [../ui]
tests: [../../../../tests/ui]
description: Behavioral specification for UI Primitives
tags: [spec, kb]
timestamp: 2026-08-19T21:10:00Z
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
| TC-CR5V | FR-1 | Given human labels, then wire keys are lowercase slugs | pass |
| TC-B7LL | FR-1 | Given a line, then detects orchestration wire rows but not assistant stream | pass |
| TC-YO2A | FR-1 | Given label and value, then formats wire line | pass |
| TC-3ECA | FR-2 | Given tui mode, chat metadata keeps routing prefixes | pass |
| TC-94KG | FR-2 | Given tui mode, separator routes as orchestration meta | pass |
| TC-33UP | FR-2 | Given cli mode without tty, metadata uses orchestration wire lines | pass |
| TC-54BT | FR-2 | Given a progress sink, transient progress and clear route to it (not the transcript) | pass |
| TC-P6EW | FR-2 | Given no progress sink in tui mode, progress is dropped (no transcript spam) | pass |
| TC-P9QS | FR-2 | condenseProgressText folds whitespace and tail-truncates to the latest text | pass |
| TC-RCVU | FR-2 | createReasoningProgressSink accumulates deltas and pushes the running tail | pass |
| TC-H4KX | FR-2 | Given cli mode on a real TTY, a source with an href renders as an OSC-8 hyperlink | pass |
| TC-QQ2M | FR-2 | Given tui mode on a real TTY, a source with an href also renders as an OSC-8 hyperlink | pass |
| TC-9EAF | FR-2 | Given no real TTY (piped CLI or headless tui), the label stays plain | pass |
| TC-KZ1R | FR-2 | Given no href, the label stays plain even on a real TTY | pass |

### Related docs



