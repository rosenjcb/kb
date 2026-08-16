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
  - ../../../../tests/server/serialize.test.ts
  - ../../../../tests/ui/printer.test.ts
description: Shared query payload semantics across REST, MCP, CLI, TUI, and chat surfaces
tags: [spec, query, parity, serialization]
timestamp: 2026-08-16T21:29:00Z
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

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-1 | FR-1 | Serializer gets a slug-prefixed source path and a matching source-repo registry | Output source label strips slug and includes a blob href |
| TC-2 | FR-2 | Serializer gets unsupported claims, ungrounded file text, and degraded retrieval | REST and MCP both return the same notes and weak evidence label |
| TC-3 | FR-3 | CLI printer renders one grouped source with symbols | Output line uses one source entry with symbol suffix on the same line |
