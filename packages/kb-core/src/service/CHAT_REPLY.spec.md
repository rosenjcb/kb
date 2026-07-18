---
type: Spec
title: "Spec: Chat Reply Presentation"
sources: [./chat-reply.ts, ./markdown-to-slack.ts]
tests:
  - ../../../../tests/core/chat-reply.test.ts
  - ../../../../tests/core/markdown-to-slack.test.ts
description: Shared answer body + Sources footer formatting (plain and Slack)
resource: ./chat-reply.ts
tags: [spec, chat, slack, presentation]
timestamp: 2026-07-18T00:00:00Z
---

### Intro

Presentation helpers that turn chat `answer` + `sources[]` into a single user-visible message. Stack role: [CHAT_REPLY.md](./CHAT_REPLY.md). Slack integration posting: [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md) FR-11 / TC-100.

### Definitions

- **Flavor**: `plain` (markdown-ish) or `slack` (mrkdwn body + `*Sources*` footer)
- **Normalize**: strip index prefixes, drop unusable schemes, dedupe by path+symbol, optional blob `href`

### Scope

## In Scope
- `repoRelativeSourcePath`, `normalizeChatSources`, footers, `formatChatReply`
- Deterministic Markdown → Slack mrkdwn

## Out of Scope
- Chat synthesis / SSE event emission — [CHAT.md](../core/CHAT.md)
- Slack signature / routing — [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md)
- Browser demo markdown renderer — [demo/README.md](../../../../demo/README.md)

### Functional Requirements

| ID | Requirement |
|----|------------|
| FR-1 | Strip default index prefixes (`rosenjcb-kb`, `kb`) and keep `fact://` ids; drop other schemes |
| FR-2 | Deduplicate sources by path (+ symbol) and build blob hrefs when `sourceRepoUrl` is set |
| FR-3 | `formatChatReply` appends a Sources footer in plain flavor; omits footer when sources empty |
| FR-4 | `flavor: 'slack'` converts the answer body via `markdownToSlackMrkdwn` and formats Slack Sources links |
| FR-5 | `markdownToSlackMrkdwn` maps ATX headers→bold, GFM tables→` · ` rows, `**`→`*`, lists→`•`, preserves fences |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Indexed path / fact:// / https | strip prefix; keep fact; drop https |
| TC-2 | FR-2 | Duplicate paths + repo URL | one entry; blob href present |
| TC-3 | FR-3 | Plain reply with duplicate sources | footer once; answer alone if empty sources |
| TC-4 | FR-4 | Slack flavor + repo URL | `*Sources*` + `<url\|label>` |
| TC-5 | FR-5 | Headers, tables, fences, lists, inline | mrkdwn shapes; no raw `###` / `**` after convert |
| TC-6 | FR-4 | Slack flavor end-to-end body+footer | converted body then Sources |
