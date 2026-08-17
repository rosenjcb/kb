---
type: Spec
title: "Spec: Chat Reply Presentation"
sources: [./chat-reply.ts, ./source-grouping.ts, ./markdown-to-slack.ts, ../ops/git-sync.ts]
tests:
  - ../../../../tests/core/chat-reply.test.ts
  - ../../../../tests/core/markdown-to-slack.test.ts
description: Shared answer body + Sources footer; per-repo blob links from volume registry
tags: [spec, chat, slack, presentation]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

Presentation helpers that turn chat `answer` + `sources[]` into a single user-visible message with per-repo Sources links. Citations are **source-centric**: the ranked facts are collapsed into a ranked list of *files* (`groupSources`), each folding its fact subjects (symbols); non-openable refs are dropped. Stack role: [CHAT_REPLY.md](./CHAT_REPLY.md). Slack posting: [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md) FR-11 / TC-100–TC-101.

### Definitions

- **Flavor**: `plain` or `slack` (mrkdwn body + `*Sources*` footer)
- **Source repo**: `{ slug, browseUrl, branch }` from a volume clone (`discoverBaseRepos`)
- **Primary branch**: that clone's current branch (`url#branch` / `--branch` / remote HEAD at clone time; a bare `HEAD` clone links via `HEAD`)
- **Grouped source**: one cited file `{ path, label, href?, symbols[], facts[], factCount }` (`source-grouping.ts`)

### Scope

## In Scope
- `gitRemoteToBrowseUrl`, `chatSourceReposFromBaseRepos`, `resolveChatSourceDisplay`
- `groupSources` (fact→file collapse, cap, drop non-openable) + `formatGroupedSourcesFooter` / `formatGroupedChatReply`
- Deterministic Markdown → Slack mrkdwn

## Out of Scope
- Clone/pull lifecycle — [INIT.md](../core/INIT.md)
- Slack signature / routing — [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md)
- Pages demo hardcode — [demo/README.md](../../../../demo/README.md)

### Functional Requirements

| ID | Requirement |
|----|------------|
| FR-1 | `resolveChatSourceDisplay` keeps `fact://` ids; drops other URI schemes |
| FR-2 | `groupSources` collapses facts into ranked *files*: dedupe by path, fold distinct symbols, drop non-openable (`fact://`) refs, cap at `maxSources`; blob hrefs from `sourceRepos` |
| FR-3 | `formatGroupedChatReply` appends a Sources footer in plain flavor; omits footer when sources empty |
| FR-4 | `flavor: 'slack'` converts the answer body via `markdownToSlackMrkdwn` and formats Slack Sources links |
| FR-5 | `markdownToSlackMrkdwn` maps ATX headers→bold, GFM tables→` · ` rows, `**`→`*`, lists→`•`, preserves fences |
| FR-6 | `gitRemoteToBrowseUrl` maps https/ssh remotes to browse roots and returns null for local/`file://` paths |
| FR-7 | Multi-repo: each source uses its own slug's browse URL and primary branch; unknown slugs get no href; a bare `HEAD` clone still links via `HEAD` |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-4P8G | FR-1 | fact:// / https | keep fact; drop https |
| TC-03Q7 | FR-2 | Duplicate paths + symbols + fact:// + single registry repo | one file per path; symbols folded; fact:// dropped; blob href on that repo's branch |
| TC-NL7F | FR-3 | Plain reply with duplicates / empty sources | footer once; answer alone if empty |
| TC-AZBG | FR-4 | Slack flavor + registry | `*Sources*` + `<url\|label>` |
| TC-7V3F | FR-5 | Headers, tables, fences, lists, inline | mrkdwn shapes; no raw `###` / `**` |
| TC-WLK4 | FR-4 | Slack flavor end-to-end body+footer | converted body then Sources |
| TC-7FWQ | FR-6 | https/ssh/local remotes; BaseRepo filter | browse roots; skip local; bare HEAD kept |
| TC-TULY | FR-7 | Two slugs with different branches | distinct hrefs; unknown slug → label only |
| TC-B7JK | FR-2 | More files than `maxSources`; a repeat of a cited file | list capped; later fact still folds into its file |
