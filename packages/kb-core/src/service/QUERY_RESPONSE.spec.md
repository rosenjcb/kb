---
type: Spec
title: "Spec: Query Response Parity"
sources:
  - ./serialize.ts
  - ./chat-reply.ts
  - ../ui/printer.ts
  - ../../../kb-server/src/http-server.ts
  - ../../../kb-server/src/mcp-tools.ts
  - ../../../kb-server/src/chat-stream.ts
  - ../../../kb-client/src/cli/remote-commands.ts
tests:
  - ../../../../tests/service/query-response-parity.test.ts
  - ../../../../tests/server/serialize.test.ts
  - ../../../../tests/server/mcp-tools.test.ts
  - ../../../../tests/server/http-server.test.ts
description: Shared query payload semantics across REST, MCP, CLI, TUI, and chat surfaces
tags: [spec, query, parity, serialization]
timestamp: 2026-08-30T04:00:00Z
---

### Intro

This spec defines one canonical query payload for all KB surfaces. The same payload must serve REST, MCP, CLI, TUI, and chat streams. A surface can change rendering only.

### Definitions

- Canonical query body: The full response from `serializeQueryResult`.
- Lean query body: The trimmed response from `serializeMcpQueryResult`.
- Grounding caveat: A note that warns about weak evidence, unsupported claims, or degraded retrieval.

### Scope

## In Scope
- Canonical query serialization in [serialize.ts](/Users/rosenjcb/kb/packages/kb-core/src/service/serialize.ts)
- Source-repo resolution in [chat-reply.ts](/Users/rosenjcb/kb/packages/kb-core/src/service/chat-reply.ts)
- Query response wiring in [http-server.ts](/Users/rosenjcb/kb/packages/kb-server/src/http-server.ts), [mcp-tools.ts](/Users/rosenjcb/kb/packages/kb-server/src/mcp-tools.ts), and [chat-stream.ts](/Users/rosenjcb/kb/packages/kb-server/src/chat-stream.ts)
- CLI/TUI source line rendering in [remote-commands.ts](/Users/rosenjcb/kb/packages/kb-client/src/cli/remote-commands.ts) and [printer.ts](/Users/rosenjcb/kb/packages/kb-core/src/ui/printer.ts)

## Out of Scope
- Retrieval ranking logic and claim-verification generation
- Provider-specific synthesis behavior

### Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | The canonical serializer returns grouped sources and includes blob href values when source repos are available |
| FR-2 | The canonical serializer computes grounding notes and adjusted evidence once, and both REST and MCP carry the same values |
| FR-3 | CLI and TUI query output render the shared notes and grouped source lines from the payload without custom re-derivation |
| FR-4 | [NEW] The serializer puts `IntentResult.explanation` and `recommendedAction` into `notes` so empty-base messages reach REST and MCP |
| FR-5 | [NEW] HTTP `/v1/query` and MCP `query` responses include the served `base` slug from the resolved service |
| FR-6 | [NEW] When a query returns no sources, the serializer notes the served base and reminds the caller to check KB_BASE / eval-* naming |
| FR-7 | [NEW] When the answer names a file the sources do not contain, or makes an unsupported claim, status is uncertain — not accepted |
| FR-8 | [NEW] Lean MCP sources prefer files the answer names and drop prompt and changelog files the answer does not name |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-GEV5 | FR-1 | Serializer gets a slug-prefixed source path and a matching source-repo registry | Output source label strips slug and includes a blob href |
| TC-0T3O | FR-2 | Serializer gets unsupported claims, ungrounded file text, and degraded retrieval | REST and MCP both return the same notes and weak evidence label |
| TC-TBPH | FR-3 | CLI printer renders one grouped source with symbols | Output line uses one source entry with symbol suffix on the same line |
| TC-E233 | FR-4 | [NEW] Empty-base IntentResult with explanation and recommendedAction | Lean MCP body notes list both strings; answer stays null |
| TC-B233 | FR-5 | [NEW] MCP query against a stub service whose health base is `base` | Response JSON includes `"base": "base"` |
| TC-H233 | FR-5 | [NEW] authorized `/v1/query` against a stub whose health base is `base` | response JSON includes `"base": "base"` |
| TC-NS33 | FR-6 | [NEW] Lean serialize with base `raylib` and zero sources | Notes name the base and mention eval-raylib naming drift |
| TC-UGST | FR-7 | [NEW] Answer names `dto.ts` and sources list `reversal.ts` | REST and MCP status are uncertain; evidence is weak |
| TC-LEAN | FR-8 | [NEW] Answer names App.tsx; results lead with a prompt file and CHANGELOG | Lean MCP sources start with App.tsx and omit the prompt and changelog |
| TC-NOIZ | FR-8 | [NEW] Answer names no files; results are a prompt file then INIT.md | Lean MCP sources contain only INIT.md |
