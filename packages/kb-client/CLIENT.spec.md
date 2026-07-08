---
type: Spec
title: "Spec: KB Client"
sources: ./CLIENT.md,./src/cli/index.ts
# Umbrella spec: FR/TC detail is delegated to CONNECTION/CLI/UI sub-specs, so this
# file declares no TC rows. Scope coverage to its own (tag-free) source tree rather
# than letting it fall back to a whole-repo [TC-N] scan.
tests: ./src
description: Behavioral specification for the kb CLI client (remote default, connection visibility)
tags: [spec, kb, client]
timestamp: 2026-07-05T00:00:00Z
---

### Intro

Thin terminal front-end for kb. Taxonomy: [CLIENT.md](./CLIENT.md), [CONNECTION.md](./src/api/CONNECTION.md), [CLI.md](./src/cli/CLI.md).

### Scope

## In Scope
- Connection profile, HTTP SDK, remote command routing, user-visible host/base context

## Out of Scope
- Command implementations on server ([`@kb/core`](../kb-core/CORE.md))
- Server-side indexing ([SERVER.md](../kb-server/src/SERVER.md))

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Default path: resolve server from env; health-check via `/healthz` |
| FR-2 | When the server is unreachable, fail fast with actionable hints — no silent local fallback |
| FR-3 | `KB_LOCAL_MODE=true` runs commands in-process (tests, eval) |
| FR-4 | Remote mode forwards docs/facts/graph/logs/publish/base (except `use`) to `POST /v1/admin/cli` |
| FR-5 | Remote query uses `POST /v1/query`; chat/TUI uses `POST /v1/chat` SSE |
| FR-6 | Client-only: `skills`, `uninstall`, `sync`, `base use` |
| FR-7 | Daemon lifecycle uses the `kb-server` binary, not a `kb server` subcommand |
| FR-8 | Git-repo indexing is configured on kb-server (`KB_GIT_REPOS`) |
| FR-9 | Global `--host` overrides connection env for one invocation |
| FR-10 | Connection context (`host` + `base`) is shown on CLI banner, TUI status bar, and chat open |

Detailed connection FR/TC tables → [CONNECTION.spec.md](./src/api/CONNECTION.spec.md).
