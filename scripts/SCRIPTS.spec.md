---
type: Spec
title: "Spec: Repo Scripts"
sources: [./]
tests: [../tests/scripts]
description: Behavioral specification for Repo Scripts
tags: [spec, kb]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

Behavioral requirements. Architecture: [INSTALL.md](INSTALL.md).

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
| FR-1 | Changeset consistency gate enforces version bump policy on PRs |
| FR-2 | Node version check enforces engines.node before install |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | passes when kb source is bumped and no changeset remains | pass |
| TC-2 | FR-1 | fails when kb source changed but the version was not bumped | pass |
| TC-3 | FR-1 | fails when a pending changeset has not been applied | pass |
| TC-4 | FR-1 | requires only the affected package to bump (kb-server untouched) | pass |
| TC-5 | FR-1 | fails when kb-server source changed without a kb-server bump | pass |
| TC-6 | FR-1 | allows kb and kb-server to bump independently in one PR | pass |
| TC-7 | FR-1 | passes for docs/config-only PRs with no bump | pass |
| TC-8 | FR-1 | passes when only http test-collection files change under packages/kb-server | pass |
| TC-9 | FR-1 | fails when more than one changeset is pending | pass |
| TC-10 | FR-1 | fails when the version jumped more than one step | pass |
| TC-11 | FR-1 | passes for a patch bump (exactly one step) | pass |
| TC-12 | FR-1 | passes for a major bump (exactly one step) | pass |
| TC-13 | FR-1 | fails when minor bumped but patch not reset | pass |
| TC-14 | FR-1 | fails when the version was downgraded | pass |
| TC-15 | FR-2 | parses major-only specs | pass |
| TC-16 | FR-2 | parses major.minor.patch specs | pass |
| TC-17 | FR-2 | returns [0,0,0] for unrecognized specs | pass |
| TC-18 | FR-1 | passes for a single major step from pre-1.0 | pass |
| TC-19 | FR-2 | accepts equal versions | pass |
| TC-20 | FR-2 | accepts newer major | pass |
| TC-21 | FR-2 | accepts newer minor on same major | pass |
| TC-22 | FR-2 | rejects older major | pass |
| TC-23 | FR-2 | rejects older patch when major/minor match | pass |
| TC-24 | FR-2 | passes when engines.node is absent | pass |
| TC-25 | FR-2 | passes when current version meets minimum | pass |
| TC-26 | FR-2 | fails when current version is below minimum | pass |
| TC-27 | FR-2 | includes nvm/fnm hints when .nvmrc is present | pass |
| TC-28 | FR-2 | falls back to generic install hint without .nvmrc | pass |
| TC-29 | FR-2 | returns 0 when package.json has no engines.node | pass |
| TC-30 | FR-2 | returns 0 when current version satisfies engines.node | pass |
| TC-31 | FR-2 | returns 1 and prints nvm hints when version is too old | pass |

### Related docs

- [INSTALL.md](INSTALL.md)
