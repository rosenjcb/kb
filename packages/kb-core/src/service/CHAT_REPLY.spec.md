---
type: Spec
title: "Spec: Chat Reply Presentation"
sources: [./chat-reply.ts, ./markdown-to-slack.ts, ../ops/git-sync.ts]
tests:
  - ../../../../tests/core/chat-reply.test.ts
  - ../../../../tests/core/markdown-to-slack.test.ts
description: Shared answer body + Sources footer; per-repo blob links from volume registry
tags: [spec, chat, slack, presentation]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

Presentation helpers that turn chat `answer` + `sources[]` into a single user-visible message with per-repo Sources links. Stack role: [CHAT_REPLY.md](./CHAT_REPLY.md). Slack posting: [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md) FR-11 / TC-100–TC-101.

### Definitions

- **Flavor**: `plain` or `slack` (mrkdwn body + `*Sources*` footer)
- **Source repo**: `{ slug, browseUrl, branch }` from a volume clone (`discoverBaseRepos`)
- **Primary branch**: that clone's current branch (`url#branch` / `--branch` / remote HEAD at clone time)

### Scope

## In Scope
- `gitRemoteToBrowseUrl`, `chatSourceReposFromBaseRepos`, normalize/footer/`formatChatReply`
- Deterministic Markdown → Slack mrkdwn

## Out of Scope
- Clone/pull lifecycle — [INIT.md](../core/INIT.md)
- Slack signature / routing — [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md)
- Pages demo hardcode — [demo/README.md](../../../../demo/README.md)

### Functional Requirements

| ID | Requirement |
|----|------------|
| FR-1 | Keep `fact://` ids; drop other URI schemes from source display |
| FR-2 | Deduplicate sources by path (+ symbol); build blob hrefs from `sourceRepos` (slug → browseUrl + branch) |
| FR-3 | `formatChatReply` appends a Sources footer in plain flavor; omits footer when sources empty |
| FR-4 | `flavor: 'slack'` converts the answer body via `markdownToSlackMrkdwn` and formats Slack Sources links |
| FR-5 | `markdownToSlackMrkdwn` maps ATX headers→bold, GFM tables→` · ` rows, `**`→`*`, lists→`•`, preserves fences |
| FR-6 | `gitRemoteToBrowseUrl` maps https/ssh remotes to browse roots and returns null for local/`file://` paths |
| FR-7 | Multi-repo: each source uses its own slug's browse URL and primary branch; unknown slugs get no href |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | fact:// / https | keep fact; drop https |
| TC-2 | FR-2 | Duplicate paths + single registry repo | one entry; blob href on that repo's branch |
| TC-3 | FR-3 | Plain reply with duplicates / empty sources | footer once; answer alone if empty |
| TC-4 | FR-4 | Slack flavor + registry | `*Sources*` + `<url\|label>` |
| TC-5 | FR-5 | Headers, tables, fences, lists, inline | mrkdwn shapes; no raw `###` / `**` |
| TC-6 | FR-4 | Slack flavor end-to-end body+footer | converted body then Sources |
| TC-7 | FR-6 | https/ssh/local remotes; BaseRepo filter | browse roots; skip local + detached HEAD |
| TC-8 | FR-7 | Two slugs with different branches | distinct hrefs; unknown slug → label only |
