---
type: Spec
title: "Spec: KB Client"
sources: ./,../../tests/cli/kb-api-client.test.ts
description: Behavioral specification for the kb CLI client (remote default, local escape hatch)
tags: [spec, kb, client]
timestamp: 2026-07-03T00:00:00Z
---

### Intro

Thin terminal front-end for kb. Taxonomy: [CLIENT.md](./CLIENT.md), [CLI.md](./src/cli/CLI.md).

### Scope

## In Scope
- Connection profile, HTTP SDK, postgres-style connection errors

## Out of Scope
- Full CLI command surface ([CLI.spec.md](./src/cli/CLI.spec.md)); indexing/retrieval ([@kb/core](../kb-core/CORE.md))

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Default path: resolve server host/port from env and `~/.kb/config.json`; health-check via `/healthz` |
| FR-2 | When the server is unreachable, fail fast with a postgres-style hint (`kb-server start`, check host/port) |
| FR-3 | `KB_LOCAL_MODE=1` runs query/chat in-process via `@kb/core` (tests, eval harness) |
| FR-4 | `kb server` subcommand is not registered — daemon lifecycle is `kb-server` only |

### Test Cases

| ID | Covers | Scenario |
|------|--------|----------|
| TC-1 | FR-1 | `KBHOST`/`KBPORT` default to localhost:8080 |
| TC-2 | FR-1 | `KB_SERVER_URL` overrides host/port |
| TC-3 | FR-1 | `health()` calls `/healthz` |
| TC-4 | FR-2 | Connection errors include setup hints |
