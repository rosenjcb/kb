---
type: Spec
title: "Spec: KB HTTP, MCP, and Slack Server"
sources: [./]
tests: [../../../tests/server]
description: Behavioral specification for KB HTTP, MCP, and Slack Server
tags: [spec, kb]
timestamp: 2026-06-28T04:04:52Z
---

### Intro

Long-lived HTTP service with REST, optional MCP, and Slack. Stack wiring and invariants: [SERVER.md](./SERVER.md). Query pipeline: [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- Black-box HTTP contract tests — see [`HTTP.spec.md`](../../packages/kb-server/http/HTTP.spec.md)

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Stream chat synthesis over SSE |
| FR-2 | Expose authenticated REST routes for query, chat, reindex, and health; `/healthz` includes `version.server` (not `@kb/core`) |
| FR-3 | KbService reads facts, reports health, and serializes reindex |
| FR-4 | Expose MCP tools with read-only allowlist |
| FR-5 | Parse and run periodic reindex scheduler |
| FR-6 | Serialize IntentResult to REST JSON |
| FR-7 | Resolve bootstrap base, repos, branch, and ignore patterns from env and flags |
| FR-8 | Start server CLI with bootstrap logging and deferred scheduler |
| FR-8a | Print package version for `--version` / `-V` without starting the daemon |
| FR-9 | Store in-memory chat session history with TTL and caps |
| FR-10 | Verify Slack signatures, route events, and deduplicate retries |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | streams reasoning then a terminal answer and done | pass |
| TC-2 | FR-1 | emits an error event when synthesis throws | pass |
| TC-3 | FR-2 | serves /healthz without auth | pass |
| TC-4 | FR-2 | rejects /v1/query without a valid key | pass |
| TC-5 | FR-2 | answers /v1/query with a serialized body when authorized | pass |
| TC-6 | FR-2 | returns 503 for /v1/query while the server is bootstrapping its first index | pass |
| TC-7 | FR-2 | returns 400 when q is missing | pass |
| TC-8 | FR-2 | returns 409 when a reindex is already running | pass |
| TC-9 | FR-2 | triggers reindex and returns the summary | pass |
| TC-10 | FR-2 | streams /v1/chat as SSE with a session id, answer, and done | pass |
| TC-11 | FR-2 | returns 400 when chat message is missing | pass |
| TC-12 | FR-2 | 404s on unknown routes and when MCP is disabled | pass |
| TC-13 | FR-2 | writes a RunReport to disk for /v1/query | pass |
| TC-14 | FR-2 | writes an error RunReport when /v1/query fails | pass |
| TC-15 | FR-2 | does not write a RunReport for /healthz | pass |
| TC-16 | FR-3 | scans the repos discovered on the base volume | pass |
| TC-17 | FR-3 | readFacts returns matching facts from the on-disk index | pass |
| TC-18 | FR-3 | health reports the base name and a present index mtime | pass |
| TC-19 | FR-3 | serializes concurrent reindex calls via the in-process guard | pass |
| TC-20 | FR-3 | health reports indexing while background bootstrap is still running | pass |
| TC-21 | FR-4 | exposes kb_query plus the read-only allowlist, prefixed and never upsert_fact | pass |
| TC-22 | FR-4 | runs kb_query without synthesis by default | pass |
| TC-23 | FR-4 | errors when kb_query is missing q | pass |
| TC-24 | FR-4 | delegates allowlisted registry tools to the executor | pass |
| TC-25 | FR-4 | refuses tools outside the allowlist | pass |
| TC-26 | FR-5 | parses unit suffixes | pass |
| TC-27 | FR-5 | treats bare numbers as milliseconds | pass |
| TC-28 | FR-5 | defaults to one hour when unset or empty | pass |
| TC-29 | FR-5 | returns 0 (disabled) for "0" | pass |
| TC-30 | FR-5 | returns undefined for malformed values | pass |
| TC-31 | FR-5 | is inert when interval <= 0 | pass |
| TC-32 | FR-5 | runs ticks and skips overlapping runs | pass |
| TC-33 | FR-5 | does not emit a completion line when a tick is intentionally skipped | pass |
| TC-34 | FR-6 | maps a read_facts IntentResult into the REST response body | pass |
| TC-35 | FR-6 | returns null answer when none is present | pass |
| TC-36 | FR-7 | splits on commas and whitespace, preserving inline #branch | pass |
| TC-37 | FR-7 | handles newline-separated multi-line values and ignores blanks | pass |
| TC-38 | FR-7 | applies the default branch only when no inline branch is given | pass |
| TC-39 | FR-7 | returns [] for undefined/empty | pass |
| TC-43 | FR-7 | resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE) | pass |
| TC-44 | FR-7 | lets the --base flag win over env | pass |
| TC-46 | FR-7 | reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS) | pass |
| TC-47 | FR-7 | lets --git flags win over env repos | pass |
| TC-48 | FR-7 | reads ignore patterns from KB_SERVER_IGNORE | pass |
| TC-50 | FR-7 | reports source "none" and no ignore when nothing is declared | pass |
| TC-51 | FR-7 | applies --branch as the default branch for targets without an inline pin | pass |
| TC-52 | FR-8 | forwards background init progress lines into server logging | pass |
| TC-53 | FR-8 | starts the reindex scheduler only after bootstrap init completes | pass |
| TC-53a | FR-8a | Given `kb-server --version`, prints version and does not listen | pass |
| TC-54 | FR-9 | returns empty history for an unknown session | pass |
| TC-55 | FR-9 | appends user/assistant turns and reads them back | pass |
| TC-56 | FR-9 | trims to the configured turn cap | pass |
| TC-57 | FR-9 | evicts sessions past their TTL | pass |
| TC-58 | FR-9 | clear removes a single session | pass |
| TC-59 | FR-10 | returns true for a valid signature | pass |
| TC-60 | FR-10 | returns false when signature is wrong | pass |
| TC-61 | FR-10 | returns false when timestamp is missing | pass |
| TC-62 | FR-10 | returns false when signature is missing | pass |
| TC-63 | FR-10 | returns false when timestamp is older than 5 minutes (replay attack) | pass |
| TC-64 | FR-10 | returns false when signing secret is wrong | pass |
| TC-65 | FR-10 | strips a single leading mention | pass |
| TC-66 | FR-10 | strips multiple leading mentions | pass |
| TC-67 | FR-10 | leaves text unchanged when no mention is present | pass |
| TC-68 | FR-10 | returns empty string when only a mention is present | pass |
| TC-69 | FR-10 | returns false the first time an event_id is seen | pass |
| TC-70 | FR-10 | returns true for a repeated event_id | pass |
| TC-71 | FR-10 | rejects unsigned requests with 401 | pass |
| TC-72 | FR-10 | rejects requests with a wrong secret | pass |
| TC-73 | FR-10 | rejects stale-timestamp requests | pass |
| TC-74 | FR-10 | echoes the challenge for url_verification | pass |
| TC-75 | FR-10 | acks 200 for an app_mention event | pass |
| TC-76 | FR-10 | acks 200 for a DM message event | pass |
| TC-77 | FR-10 | acks 200 for a threaded app_mention (chat mode) | pass |
| TC-78 | FR-10 | ignores bot messages to prevent reply loops | pass |
| TC-79 | FR-10 | deduplicates events with the same event_id | pass |
| TC-80 | FR-10 | returns 404 when slack is not configured | pass |
| TC-81 | FR-10 | posts indexing progress first, then answers after bootstrap settles | pass |

### Related docs

- [SERVER.md](SERVER.md)
- [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md)
