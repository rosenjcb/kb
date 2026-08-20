---
type: Spec
title: "Spec: Chat Reply Presentation"
sources:
  [
    ./chat-reply.ts,
    ./source-grouping.ts,
    ./serialize.ts,
    ./markdown-to-slack.ts,
    ../ops/git-sync.ts,
    ../storage/base-repos.ts,
  ]
tests:
  - ../../../../tests/core/chat-reply.test.ts
  - ../../../../tests/core/markdown-to-slack.test.ts
  - ../../../../tests/cli/base-repos.test.ts
  - ../../../../tests/server/serialize.test.ts
description: Shared answer body + Sources footer; per-repo blob links from volume registry
tags: [spec, chat, slack, presentation]
timestamp: 2026-08-19T19:20:00Z
---

### Intro

Presentation helpers that turn chat `answer` + `sources[]` into a single user-visible message with per-repo Sources links. Citations are **source-centric**: the ranked facts are collapsed into a ranked list of *files* (`groupSources`), each folding its fact subjects (symbols); non-openable refs are dropped. Stack role: [CHAT_REPLY.md](./CHAT_REPLY.md). Slack posting: [SERVER.spec.md](../../../kb-server/src/SERVER.spec.md) FR-11 / TC-100–TC-101.

### Definitions

- **Flavor**: `plain` or `slack` (mrkdwn body + `*Sources*` footer)
- **Source repo**: `{ slug, browseUrl, branch, repoId }` from the repo registry (`resolveBaseRepoRegistry`)
- **Repo registry**: a base's tracked repos — live clones under `repos/*`, or the snapshot manifest's provenance when the base carries no clones
- **Clone slug**: the local clone dir name and fact provenance tag (`rosenjcb-kb`, `kb-2026-08-15-1419-kb`). Infrastructure. Never shown to a user
- **Repo id**: the public identity from the remote (`rosenjcb/kb`). The only repo name a user sees
- **Citation form**: a cited file has two — the repo-relative `path` an agent opens, and the blob `href` a human clicks
- **Primary branch**: that clone's current branch (`url#branch` / `--branch` / remote HEAD at clone time; a bare `HEAD` clone links via `HEAD`)
- **Grouped source**: one cited file `{ path, label, href?, symbols[], facts[], factCount }` (`source-grouping.ts`)

### Scope

## In Scope
- `gitRemoteToBrowseUrl`, `resolveBaseRepoRegistry`, `chatSourceReposFromBaseRepos`, `resolveChatSourceDisplay`
- `groupSources` (fact→file collapse, cap, drop non-openable) + `formatGroupedSourcesFooter` / `formatGroupedChatReply`
- The two citation forms (`path`, `href`) on every surface, lean MCP payload included
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
| FR-8 | `resolveBaseRepoRegistry` reads live clones first, then the snapshot manifest's provenance. A base with no clones still has a registry |
| FR-9 | A citation never contains a clone slug. `path` is repo-relative, and it carries the `repoId` prefix only when the answer spans repos |
| FR-10 | Each surface gets both citation forms from one registry. The lean MCP payload carries `path` and `href`, the same values the other surfaces render |
| FR-11 | The serializers require `sourceRepos`. A surface cannot omit the registry and silently return unlinked citations |

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
| TC-TULY | FR-7, FR-9 | Two slugs with different branches | distinct hrefs; paths carry `repoId`, not the clone slug; unknown slug → repo-relative path, no href |
| TC-B7JK | FR-2 | More files than `maxSources`; a repeat of a cited file | list capped; later fact still folds into its file |
| TC-Q8XM | FR-8 | Base with a manifest and no clones; base with both | manifest provenance stands in; live clones win when present |
| TC-N3WQ | FR-9 | A `kb-2026-08-15-1419-kb/…` fact, with an empty / matching / multi registry | no returned path contains the clone slug, in any of the three |
| TC-6KDA | FR-10 | Lean MCP payload with a matching registry | source carries repo-relative `path` **and** blob `href` |

FR-11 has no `TC-N`. It is a type-level guarantee, so `pnpm run type-check` is its gate.
