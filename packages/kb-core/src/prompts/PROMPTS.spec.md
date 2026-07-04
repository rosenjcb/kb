---
type: Spec
title: "Spec: Prompt Assets"
sources: ./,../../tests/prompts
description: Behavioral specification for Prompt Assets
tags: [spec, kb]
timestamp: 2026-06-28T04:05:30Z
---

### Intro

Behavioral requirements. Architecture: [README.md](README.md).

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
| FR-1 | Behaviors in loader.test.ts |
| FR-2 | Behaviors in prompt-assets.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | loads a prompt file as a trimmed string | pass |
| TC-2 | FR-1 | throws on a missing file | pass |
| TC-3 | FR-1 | splits on the --- divider | pass |
| TC-4 | FR-1 | trims both parts | pass |
| TC-5 | FR-1 | intro does not contain the divider | pass |
| TC-6 | FR-1 | instructions does not contain the divider | pass |
| TC-7 | FR-1 | throws when the prompt file has no --- divider | pass |
| TC-8 | FR-1 | all two-part prompt files parse without throwing | pass |
| TC-9 | FR-2 | resolvePromptPath nests under prompts root | pass |
| TC-10 | FR-2 | readPromptAssetUtf8 reads questionnaire file | pass |

### Related docs

- [README.md](README.md)

