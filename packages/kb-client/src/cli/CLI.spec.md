---
type: Spec
title: "Spec: CLI Layer"
sources: [./]
# Precise, disjoint scope: tests/cli minus the files owned by CONNECTION.spec.md
# (kb-api-client, cli-global-flags, mcp-config-sync, remote-commands). TC ids are
# per-spec, so a whole-dir claim would over-select CONNECTION's [TC-N] tags. Add
# new tests/cli files here when they carry CLI [TC-N] tags.
tests:
  - ../../../../tests/cli/auto-sync.test.ts
  - ../../../../tests/cli/base-cli.test.ts
  - ../../../../tests/cli/base-repos.test.ts
  - ../../../../tests/cli/base-selection.test.ts
  - ../../../../tests/cli/chat-cli.test.ts
  - ../../../../tests/cli/chat-query-orchestrator.test.ts
  - ../../../../tests/cli/chat-retrieval-refusal.test.ts
  - ../../../../tests/cli/cmd-ref.test.ts
  - ../../../../tests/cli/collect-source-files.test.ts
  - ../../../../tests/cli/facts-cli.test.ts
  - ../../../../tests/cli/git-sync.test.ts
  - ../../../../tests/cli/graph-cli.test.ts
  - ../../../../tests/cli/init-ast-files-manifest.test.ts
  - ../../../../tests/cli/init-cli-rescan-multi-repo.test.ts
  - ../../../../tests/cli/init-cli.test.ts
  - ../../../../tests/cli/init-source-files-manifest.test.ts
  - ../../../../tests/cli/init-source-snapshots.test.ts
  - ../../../../tests/cli/init-topic-coverage.test.ts
  - ../../../../tests/cli/intent-cli.test.ts
  - ../../../../tests/cli/kb-config.test.ts
  - ../../../../tests/cli/kb-ignore.test.ts
  - ../../../../tests/cli/logs-cli.test.ts
  - ../../../../tests/cli/repo-slug.test.ts
  - ../../../../tests/cli/session-cli.test.ts
  - ../../../../tests/cli/skill-installer.test.ts
  - ../../../../tests/cli/startup-notices.test.ts
  - ../../../../tests/cli/sync-cli.test.ts
  - ../../../../tests/cli/uninstall-cli.test.ts
description: Behavioral specification for CLI Layer
tags: [spec, kb]
timestamp: 2026-08-23T07:15:00Z
---

### Intro

Command-line parsing and orchestration. Taxonomy: [CLI.md](./CLI.md). Client overview: [CLIENT.md](../../CLIENT.md). TUI standards: [TUI.md](../../../kb-core/src/core/TUI.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Repo sync pulls each clone on the volume and re-indexes those with new commits |
| FR-2 | Global CLI routing parses flags, defaults, and dispatches subcommands |
| FR-3 | Repo slug/dir helpers and on-volume repo discovery |
| FR-4 | [UPDATED] Base selection resolves `--base`, then the active base; with neither set, the hardcoded `default` slug applies — the client always resolves to a concrete name, never `undefined`, so it always sends an explicit `X-KB-Base` |
| FR-5 | Chat REPL delegates to kb-server `/v1/chat`; synthesis helpers stay unit-tested in-client |
| FR-6 | Chat query orchestrator delegates QUERY turns to shared retrieval |
| FR-7 | Chat retrieval refusal surfaces when evidence is insufficient |
| FR-8 | Command reference generation stays in sync with registered commands |
| FR-9 | Init collects source files from configured git targets |
| FR-10 | Facts CLI parses list/read subcommands and retrieval flags |
| FR-11 | Git sync pulls tracked repos and reports sync status |
| FR-12 | [UPDATED] Graph CLI exposes summary, entity lookup, format export, and `--file` index-coverage audit |
| FR-13 | Init AST files manifest records parsed symbol files per cycle |
| FR-14 | [UPDATED] Init pipeline runs multi-cycle scan, enrichment, and synthesis. `kb init`/`kb scan` are server-only (`POST /v1/admin/cli`, no TTY): there is no interactive prompting for a base name or a git remote — a missing base (on rescan) or a missing `--git` (on fresh init) is always a hard error, never a prompt |
| FR-15 | Init source files manifest tracks cloned repo paths and branches |
| FR-16 | Init source snapshots capture per-cycle file hashes for drift detection |
| FR-17 | Init topic coverage reports document-type coverage gaps |
| FR-18 | Intent CLI parses query envelopes and routes to retrieval |
| FR-19 | [UPDATED] KB config loader merges defaults, file config, and env overrides. Config is environment-only: there is no `config.json` and nothing is auto-migrated from it |
| FR-20 | kb.ignore patterns exclude paths from indexing |
| FR-21 | Logs CLI reads structured run reports from the logs directory |
| FR-22 | Skill installer copies bundled skills to agent home directories, installs hooks, and syncs Cursor/Claude/Antigravity MCP `kb` entries to the active connection (localhost default) — opt-in via `kb skills install` / `kb mcp install`; CLI and TUI startup never auto-install skills or rewrite MCP configs. The kb-first reminder hook fires only on repo-search commands in command position (grep/rg/find/…, `git grep`, `kb query` — never VCS/build/cloud tooling or pipeline-filter greps), throttles to one reminder per session per 15-minute window, and honors `KB_HOOK_REMINDER=false` |
| FR-23 | Startup notices print one-time migration and version hints |
| FR-24 | Sync CLI refreshes the split GitHub Release runtimes and rewires stable client/server binary links |
| FR-25 | Client uninstall removes release client layout; server uninstall removes server layout and optional ~/.kb data |
| FR-26 | Connection context (host + base) is printed on CLI banner, TUI status bar, and chat session open |
| FR-27 | Change-detection manifests are isolated per git-repo slug (base-level, surviving `--no-repos` snapshots); a warm rescan of an unchanged multi-repo base detects 0 changed per repo without clobbering sibling repos, so unchanged files are skipped instead of fully re-embedded |
| FR-28 | A partial rescan re-indexes only files whose content hash changed for that repo and tombstones only files removed from that repo since its last manifest — never unchanged files' facts nor another repo's facts |
| FR-29 | End-of-session feedback hook (Claude Code only): `kb skills install` writes `~/.kb/hooks/kb-feedback.sh` and registers it for PostToolUse (kb MCP tools), PreToolUse (Bash), and Stop. It records that the session used query, then reminds the agent **once** to call `get_feedback_requests` and resolve what it returns via `submit_feedback` — at the first command-position `git push`, or by blocking the first Stop as a fallback — staying silent after feedback is submitted, after one nudge, when query was never used, or when `KB_FEEDBACK_REMINDER=false`; `kb skills uninstall` removes the entries from all three events |
| FR-30 | Answer synthesis never fails silently: a provider error or an empty completion records a structured `answerError` on the result (retrieval results preserved, `status` still `accepted` so downstream source handling is unaffected) instead of returning an answerless success, and a curator that fell back contributes no research note claiming the evidence was focused |
| FR-31 | Session CLI groups run reports by sessionId and summarizes the most recent (or a named) session, listing each run for `kb logs show` follow-up |
| FR-32 | Bare `kb skills` reports install status per agent (installed / update available / not installed) without writing any files |
| FR-33 | `--skip-embed` on `kb init`/`kb scan` sets `skipEmbeddings` (default `false`); when set, `create-embeddings` completes without writing any vectors, and a multi-repo scan skips the embedder for both the per-repo reindex and the trailing embed pass |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-APK3 | FR-1 | Given no clones on the volume, then no-ops and returns 0 | pass |
| TC-BNCE | FR-1 | Given a repo with no new commits, then pulls but does not re-index | pass |
| TC-P865 | FR-1 | Given a repo with new commits, then pulls and re-indexes that repo by slug | pass |
| TC-VI0W | FR-1 | Given multiple repos, then only the changed repo is re-indexed | pass |
| TC-R0QY | FR-1 | Given one repo's pull fails, then the other repos still sync | pass |
| TC-VR7I | FR-2 | Given kb base use <base>, then sets activeBase and prints resolved path | pass |
| TC-JX86 | FR-2 | Given kb base use <base> that does not exist, then errors with server-managed guidance | pass |
| TC-FCBG | FR-2 | Given kb base use --show, then prints current base config | pass |
| TC-G0FE | FR-2 | Given kb base --help, then prints base help pointing deletion at the server | pass |
| TC-SL1J | FR-2 | Given kb base list, then forwards to runRemoteCliCommand | pass |
| TC-MVEM | FR-2 | Given kb base delete, then refuses client-side and does not forward to the server | pass |
| TC-ITSC | FR-2 | Given base delete in the TUI, then refuses client-side and does not forward | pass |
| TC-052V | FR-2 | Given kb --help, then prints --host and core commands | pass |
| TC-ZORN | FR-3 | returns [] when the repos/ dir is absent | pass |
| TC-12W4 | FR-3 | lists each git clone under repos/, deriving slug + dir from the layout | pass |
| TC-ITUO | FR-3 | skips non-git directories under repos/ | pass |
| TC-ZLB2 | FR-3 | repoSlugFromGitUrl handles https, ssh, and local paths | pass |
| TC-ILM4 | FR-3 | repoDirForSlug nests clones under repos/ | pass |
| TC-1AL2 | FR-4 | alias base resolves to namespaced sessions directory | pass |
| TC-55NE | FR-4 | path-like base resolves relative to cwd | pass |
| TC-UNMV | FR-4 | absolute path base is returned as-is | pass |
| TC-YRYL | FR-4 | resolves the active base from config | pass |
| TC-DH7S | FR-4 | throws when no activeBase is set (server default takes over) | pass |
| TC-IIKB | FR-4 | writeSessionBase persists the active base | pass |
| TC-EBX1 | FR-4 | [NEW] ensureBaseExists creates an empty, migrated index and reports created:true | pass |
| TC-EBX2 | FR-4 | [NEW] ensureBaseExists is idempotent — a second call reports created:false | pass |
| TC-EBX3 | FR-4 | [NEW] listAllBases includes a base materialized by ensureBaseExists | pass |
| TC-EBX4 | FR-4 | [NEW] ensureBaseExistsSync materializes the same way as the async version | pass |
| TC-Q3X2 | FR-4 | formatUseCommandHelp shows active session switching | pass |
| TC-QD3M | FR-4 | Given an existing named base, then deletes its session directory | pass |
| TC-LANX | FR-4 | Given legacy + tmp checkpoint artifacts, then purges them too | pass |
| TC-E8OQ | FR-4 | Given the base is the active base, then clears it from config | pass |
| TC-TFPC | FR-4 | Given the base does not exist on disk, then succeeds without error | pass |
| TC-EJOW | FR-4 | Given a path-like base, then throws rather than deleting arbitrary paths | pass |
| TC-O7OU | FR-4 | includes the base name and path in output | pass |
| TC-CW47 | FR-4 | mentions cleared active base when applicable | pass |
| TC-TVMB | FR-4 | returns empty array when sessions directory does not exist | pass |
| TC-NG7P | FR-4 | returns only directories that contain .kb-index.sqlite | pass |
| TC-1GXA | FR-4 | marks the active base correctly | pass |
| TC-EA5G | FR-4 | returns bases sorted alphabetically | pass |
| TC-XXX9 | FR-4 | resolves the configured active base | pass |
| TC-EHQA | FR-4 | throws when no active base is configured | pass |
| TC-OHPZ | FR-4 | readOptionalCliValue returns the following token | pass |
| TC-CVIS | FR-4 | readOptionalCliValue returns undefined when flag or value is missing | pass |
| TC-MHT9 | FR-4 | stripCliFlagWithValue removes --base and its value | pass |
| TC-1G6A | FR-4 | resolveKbStorageDirFromArgs honors --base over active session | pass |
| TC-8ODE | FR-4 | resolveKbStorageDirFromArgs falls back to effective base when --base omitted | pass |
| TC-3VUD | FR-5 | Given chat help printer, then returns grouped usage and interactive commands including /clear | pass |
| TC-L7D5 | FR-5 | Given evidence and question, then turn content includes evidence block and question without embedded history | pass |
| TC-REED | FR-5 | Given long retrieved fact bodies, then turn content truncates each fact for synthesis | pass |
| TC-HIAJ | FR-5 | Given runChatSession, then delegates to runRemoteChatSession | pass |
| TC-40RQ | FR-5 | Given retrieval provided, then synthesizes answer from pre-fetched context without extra retrieval | pass |
| TC-UHDB | FR-5 | Given multi-round loop, then calls query_kb in parallel and populates lastIntentResult | pass |
| TC-H58G | FR-5 | Given retrieval undefined (chat path), then starts loop from provided messages directly | pass |
| TC-FR8X | FR-6 | Given a mocked read_facts result, then returns accepted read_facts IntentResult | pass |
| TC-XMSJ | FR-7 | refuses when no results | pass |
| TC-7HZP | FR-7 | allows when retrieval detail is all-facts:already-in-context even with zero results | pass |
| TC-DICS | FR-7 | refuses when last checkpoint below default min | pass |
| TC-HAF4 | FR-7 | allows when checkpoints missing (no signal) | pass |
| TC-FRW1 | FR-7 | allows when last checkpoint at or above min | pass |
| TC-BN67 | FR-7 | respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE | pass |
| TC-S9Y9 | FR-7 | formats user/assistant pairs and tail-truncates | pass |
| TC-HCJ1 | FR-8 | returns /name in tui mode | pass |
| TC-MT1G | FR-8 | returns kb name in cli mode | pass |
| TC-ELYM | FR-8 | defaults to cli mode | pass |
| TC-5H2Z | FR-8 | handles multi-word names in tui mode | pass |
| TC-YY8L | FR-8 | handles multi-word names in cli mode | pass |
| TC-M14Z | FR-8 | handles names with flags in tui mode | pass |
| TC-5JUI | FR-8 | returns TUI-style intro in tui mode | pass |
| TC-90YV | FR-8 | returns CLI-style intro in cli mode | pass |
| TC-VOUJ | FR-8 | shows /command syntax in tui mode | pass |
| TC-1MJN | FR-8 | shows kb command syntax in cli mode | pass |
| TC-BSGC | FR-8 | accepts valid modes without type error | pass |
| TC-BXL6 | FR-9 | walks deeply nested directories without stopping early | pass |
| TC-FJPI | FR-9 | collects more than 100 markdown files (no file-count cap) | pass |
| TC-DS1Q | FR-9 | skips dotfile directories | pass |
| TC-KCDP | FR-9 | skips excluded directories like node_modules | pass |
| TC-C7OX | FR-9 | explores sibling directories at the same depth | pass |
| TC-HGQ6 | FR-9 | respects an ignore matcher (prunes dirs and files) | pass |
| TC-V4XI | FR-10 | Given list subcommand, then parses limit and base | pass |
| TC-48JA | FR-10 | Given --help, then throws FactsCommandError exit 0 | pass |
| TC-PJMI | FR-10 | Given search without query, then throws | pass |
| TC-F2GY | FR-10 | Given seeded facts, list and search return human text | pass |
| TC-QQAV | FR-10 | Given fact id, show returns that row | pass |
| TC-NYZ4 | FR-11 | derives name from https URL with .git suffix | pass |
| TC-76VJ | FR-11 | derives name from https URL without .git suffix | pass |
| TC-H1NA | FR-11 | derives name from https URL with trailing slash | pass |
| TC-KXS2 | FR-11 | derives name from ssh URL | pass |
| TC-XVFS | FR-11 | lowercases the result | pass |
| TC-G8ZP | FR-11 | replaces special characters (but keeps underscore, dot, dash) with dashes | pass |
| TC-4IUC | FR-11 | Given no branch, then clones the remote default branch | pass |
| TC-UOHK | FR-11 | Given an explicit branch, then clones that branch | pass |
| TC-40R5 | FR-11 | disables interactive git prompts even without a token | pass |
| TC-JAHP | FR-11 | uses GITHUB_TOKEN when present | pass |
| TC-IEOG | FR-11 | falls back to GH_TOKEN when GITHUB_TOKEN is absent | pass |
| TC-YE33 | FR-11 | prefers GITHUB_TOKEN over GH_TOKEN when both are present | pass |
| TC-H95Q | FR-11 | Given a dirty .kb marker in the clone, then pull succeeds | pass |
| TC-FDTH | FR-11 | Given dirty tracked files and no new remote commits, then pull discards local edits | pass |
| TC-9YYO | FR-11 | Given dirty tracked files and new remote commits, then pull succeeds | pass |
| TC-VPTT | FR-11 | clones a repo whose default branch is master without specifying a branch | pass |
| TC-YCUC | FR-11 | honors an explicitly requested branch | pass |
| TC-OOKL | FR-12 | Given graph help flag, then parser returns graph-specific help text | pass |
| TC-UIFR | FR-12 | Given graph entity flag, then parser returns entity lookup options | pass |
| TC-P5RI | FR-12 | Given graph path flag, then parser returns path lookup options | pass |
| TC-KY82 | FR-12 | Given graph format flag, then parser returns export format option | pass |
| TC-BY2A | FR-12 | prints grouped graph usage and examples | pass |
| TC-R3PD | FR-12 | routes default summary output through the out parameter, not console.log | pass |
| TC-5W5H | FR-12 | routes --format dot output through the out parameter | pass |
| TC-I5DI | FR-12 | routes --format json output through the out parameter | pass |
| TC-8UAF | FR-12 | reports no-path-found through the out parameter | pass |
| TC-HNK2 | FR-12 | reports no matching documents/symbols through the out parameter | pass |
| TC-BF7T | FR-13 | returns null diff when no manifest exists yet (first run) | pass |
| TC-A9HB | FR-13 | round-trips manifest writes and detects changed/new files only | pass |
| TC-W75I | FR-13 | treats unchanged contents as a no-op diff | pass |
| TC-I5B9 | FR-14 | [UPDATED] Given init without --base, then it derives the base name from the git remote slug — no prompt, even with a local active base set | pass |
| TC-KWC3 | FR-14 | Given detach and resume flags, then parses them into init options | pass |
| TC-4MNE | FR-14 | Given scan args, then parsing implies rescan and always applies automatically | pass |
| TC-PI4H | FR-14 | Given --stop-after document-facts, then parsing returns document-facts | pass |
| TC-HOLS | FR-14 | Given init cycle validation, then exactly 5 phases are defined without pass-graph | pass |
| TC-S6XJ | FR-14 | Given a custom progress sink, then init progress updates route there instead of writing directly to stderr | pass |
| TC-6HEV | FR-14 | Given interactive init, then read-inputs does not ask deprecated interview questions | pass |
| TC-3OB0 | FR-14 | Given resume after import-docs pause, then finishes init without re-asking read-inputs | pass |
| TC-YNOA | FR-14 | Given version 1 checkpoint, then resume migrates it to version 3 without reviving deprecated answers | pass |
| TC-IUR0 | FR-14 | Given detach during read-inputs, then init no longer stores pending interview questions | pass |
| TC-R6KG | FR-14 | Given legacy tmp checkpoint path, then init migrates it into KB home checkpoints | pass |
| TC-30HB | FR-14 | Given resume after read-inputs, then deprecated interview prompting does not resume | pass |
| TC-ND14 | FR-14 | Given several repo markdown files, then import-docs checkpoint lists each as original | pass |
| TC-0GAD | FR-14 | Given rescan, then read-inputs loads all markdown sources under cwd | pass |
| TC-IOJ4 | FR-14 | Given published snapshot docs, then read-inputs excludes published snapshots and export artifacts | pass |
| TC-YC8E | FR-14 | Given no markdown sources under the working directory, then document-facts stage is skipped | pass |
| TC-HBHQ | FR-14 | Given multiple markdown sources, then iterable init phases emit current-item progress | pass |
| TC-1NBT | FR-14 | Given rescan, then write cycle writes originals and any resulting mutations | pass |
| TC-5HX5 | FR-14 | Given rescan, then run writes refreshed documents instead of staying plan-only | pass |
| TC-GRLA | FR-14 | Given an unchanged second scan, then markdown sources are skipped and no original docs are rewritten | pass |
| TC-0KMZ | FR-14 | Given one changed markdown source on rescan, then only that original doc is re-imported | pass |
| TC-9Z33 | FR-14 | Given unchanged scan plan, then it does not emit preview diff chatter or synthetic scan files | pass |
| TC-H1FQ | FR-14 | Given interactive rescan, then read-inputs does not ask initial interview questions or prompt to proceed | pass |
| TC-Z054 | FR-14 | Given interactive rescan through import-docs, then follow-up interview questions are skipped without a proceed prompt | pass |
| TC-5FAE | FR-14 | Given rescan with an active base, uses it in non-interactive mode | pass |
| TC-3SGG | FR-14 | Given rescan without --base and no selected base in non-interactive mode, throws guidance | pass |
| TC-QNA6 | FR-14 | Given a full init cycle, then progress counter shows 3/3 (not more) | pass |
| TC-0R0B | FR-14 | Given a TypeScript-only project, then AST code-index uses no LLM tokens | pass |
| TC-O8A2 | FR-14 | Given an active base, uses it | pass |
| TC-V7E7 | FR-14 | Given --base flag, uses it directly | pass |
| TC-ZG04 | FR-14 | [UPDATED] Given no selected base, throws without prompting — regardless of how many other bases exist on the host | pass |
| TC-01FX | FR-14 | [UPDATED] Given no selected base and no initialized bases, throws the same error | pass |
| TC-PONX | FR-14 | Given --git flag (non-interactive), then clones the repo onto the base volume | pass |
| TC-PGIR | FR-14 | Given --git without branch, then clones the remote default branch | pass |
| TC-UIOI | FR-14 | Given multiple --git targets, then both repos index into one base and the volume lists both | pass |
| TC-1L81 | FR-14 | [UPDATED] Given init without --git, throws requiring a git remote | pass |
| TC-YYVU | FR-14 | parseInitCommand parses --git and --branch flags | pass |
| TC-98OW | FR-14 | parseInitCommand parses repeatable --git with inline branch (no branch = remote default) | pass |
| TC-TIUI | FR-14 | parseInitCommand with only --git leaves the branch undefined (remote default) | pass |
| TC-7SME | FR-15 | returns null diff when no manifest exists yet (first run) | pass |
| TC-NO8M | FR-15 | round-trips manifest writes and detects changed/new source files only | pass |
| TC-3M1Y | FR-15 | detects source files removed since the last manifest | pass |
| TC-263O | FR-15 | treats unchanged contents as a no-op diff | pass |
| TC-X447 | FR-16 | Given many autogen-only docs and several source files, then append adds frozen originals per file | pass |
| TC-KPPY | FR-16 | Given an original shard already exists for a file title, then append does not duplicate that file | pass |
| TC-60ET | FR-16 | Given README path, then isInitReadmeHomePath is true only for readme.md basename | pass |
| TC-QEKE | FR-16 | Given oversized file body, then snapshot content is clipped with truncation marker | pass |
| TC-UIF4 | FR-17 | Given grounded source, user answers, and draft docs, then marks topic sufficient | pass |
| TC-XDJ9 | FR-17 | Given contradictory deployment signals, then surfaces unresolved contradiction gap | pass |
| TC-XHOG | FR-17 | Given weak non-interactive evidence, then marks topic inferred and summarizes unresolved topics | pass |
| TC-D5E3 | FR-18 | parses query flags and query session support | pass |
| TC-L7KC | FR-18 | rejects unknown public commands | pass |
| TC-A5U9 | FR-18 | only treats query as an intent command | pass |
| TC-U3RI | FR-18 | formats read_facts results in human mode | `sources> <count>`, then one `source> <path>` line per cited file |
| TC-J2NW | FR-18 | prints minimal intent help with only the supported commands | pass |
| TC-M8QE | FR-18 | renders orchestration footer through printer helpers | pass |
| TC-313O | FR-18 | prints non-read_facts results without treating them as query results | pass |
| TC-66OY | FR-18 | derives query evidence from retrieval checkpoints instead of a fixed router default | pass |
| TC-6EBP | FR-18 | keeps query rewrite/session fallback scoped to query only | pass |
| TC-VEKI | FR-18 | enriches query answers with the LLM | pass |
| TC-9PCT | FR-18 | replaces insufficient LLM answer with deterministic fallback from documents | pass |
| TC-Y4EF | FR-18 | keeps long sufficient LLM answer unchanged | pass |
| TC-SYH8 | FR-18 | forces build/config scaffold when answer lacks required sections | pass |
| TC-5XBS | FR-18 | keeps LLM answer when synthesisQuestion is pre-expansion text (not graph-expanded query) | pass |
| TC-8JL6 | FR-18 | query synthesis allows a larger answer output budget | pass |
| TC-RFFQ | FR-19 | returns default features when no env is set | pass |
| TC-ZLRD | FR-19 | reads server profile from KB_HOST/KB_PORT env | pass |
| TC-OBQU | FR-19 | returns false when no LLM env vars are set | pass |
| TC-F4WQ | FR-19 | returns true when ANTHROPIC_API_KEY is set | pass |
| TC-43MO | FR-19 | throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set | pass |
| TC-VBAH | FR-19 | does not throw for ollama (no key required) | pass |
| TC-S6MY | FR-19 | prefers env var when provider is declared | pass |
| TC-2OBO | FR-19 | auto-detects provider from env vars when no provider is declared | pass |
| TC-TCBY | FR-19 | falls back to ollama when nothing is configured | pass |
| TC-D2EE | FR-19 | supported config paths omit base-selection keys | pass |
| TC-RW4A | FR-19 | resolveFactRetrievalMethod defaults to query_expansion | pass |
| TC-DBOL | FR-19 | KB_FACT_RETRIEVAL_METHOD env override wins | pass |
| TC-VV3K | FR-19 | gemini model override preserved in provider resolution | pass |
| TC-MA96 | FR-19 | returns inferred provider notice when llm.provider is unset and env key exists | pass |
| TC-PXZA | FR-19 | does not infer when KB_LLM_PROVIDER is already set | pass |
| TC-7GUG | FR-19 | KB_LLM_PROVIDER env wins over auto-detect | pass |
| TC-PNB4 | FR-19 | preserves createdAt on round-trip | pass |
| TC-672C | FR-19 | normalizes in memory without writing files | pass |
| TC-YKLS | FR-20 | splits on commas and newlines and trims | pass |
| TC-8974 | FR-20 | drops empties | pass |
| TC-CW5F | FR-20 | trims, removes blanks, and de-duplicates preserving order | pass |
| TC-RLP3 | FR-20 | matches bare names by basename at any depth | pass |
| TC-CGCH | FR-20 | anchors patterns that contain a slash | pass |
| TC-23SQ | FR-20 | honours a leading slash anchor | pass |
| TC-XXFU | FR-20 | trailing slash matches directories only (but still ignores their contents) | pass |
| TC-J1ZX | FR-20 | supports * within a segment and ** across segments | pass |
| TC-ASZ5 | FR-20 | supports negation to re-include | pass |
| TC-JAOO | FR-20 | skips comments and blank lines | pass |
| TC-E3LJ | FR-20 | an empty matcher ignores nothing | pass |
| TC-X1KF | FR-20 | normalizes backslashes and leading ./ in the tested path | pass |
| TC-0IEO | FR-20 | parses KB_SERVER_IGNORE (comma/newline separated) into patterns | pass |
| TC-2MJJ | FR-20 | returns [] when KB_SERVER_IGNORE is unset or empty | pass |
| TC-M270 | FR-21 | includes all three subcommands | pass |
| TC-DY6B | FR-21 | documents --since flag | pass |
| TC-JT0R | FR-21 | documents --base flag | pass |
| TC-EWYB | FR-21 | Given no reports, then returns empty message | pass |
| TC-NS1S | FR-21 | Given reports, then list includes run ID, command, and duration | pass |
| TC-KRVK | FR-21 | Given --command filter, then only matching command appears | pass |
| TC-AF3S | FR-21 | Given --limit 1, then only one row appears | pass |
| TC-HOOL | FR-21 | Given a known runId, then displays stage table | pass |
| TC-FW97 | FR-21 | Given a prefix of runId, then matches by prefix | pass |
| TC-6V8G | FR-21 | Given unknown runId, then throws not found error | pass |
| TC-MK1V | FR-21 | Given show with no runId, then throws usage error | pass |
| TC-9ZCQ | FR-21 | Given two init runs, then compare output contains stage names and deltas | pass |
| TC-UGJT | FR-21 | Given compare with --command init, then uses only init runs | pass |
| TC-CAJD | FR-21 | Given explicit runIds, then compares those two runs | pass |
| TC-JR55 | FR-21 | Given fewer than 2 runs, then throws with helpful message | pass |
| TC-T8GK | FR-21 | Given two runs with different stage sets, then union of stages appears in output | pass |
| TC-22AT | FR-21 | Given compare output totals row, then Δms matches difference between runs | pass |
| TC-T2JO | FR-21 | Given --base filter, then only reports matching that base appear | pass |
| TC-KZH2 | FR-21 | Given --base filter that matches nothing, then returns empty message | pass |
| TC-XQ5Q | FR-21 | Given --base combined with --command, then both filters apply | pass |
| TC-7I6G | FR-21 | Given --base filter, then compare uses only runs from that base | pass |
| TC-7AE2 | FR-21 | Given no subcommand, then returns help text | pass |
| TC-R6T4 | FR-21 | Given --help, then returns help text | pass |
| TC-1207 | FR-21 | Given unknown subcommand, then throws with the subcommand name | pass |
| TC-K98I | FR-22 | Given no existing skill files, then installs all agents and returns installed actions | pass |
| TC-PSA0 | FR-22 | Given already-installed skill with matching hash, then action is skipped | pass |
| TC-CHPS | FR-22 | Given stale skill hash, then action is updated | pass |
| TC-LGZ9 | FR-22 | Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb | pass |
| TC-IDPC | FR-22 | Given ~/.claude/CLAUDE.md already has KB section, then action is already-present | pass |
| TC-JK6H | FR-22 | Given ~/.codex/AGENTS.md exists without KB section, then injects blurb | pass |
| TC-DY3P | FR-22 | Given neither profile MD exists, then creates ~/.claude/CLAUDE.md | pass |
| TC-IXDI | FR-22 | Given both profile MDs exist, then only injects into whichever lacks the section | pass |
| TC-83WT | FR-22 | shows installed skill files and injected profile entries | pass |
| TC-8ZFW | FR-22 | shows skipped skill files as up-to-date | pass |
| TC-2K9N | FR-22 | Given installed skill files, then removes them and reports removed | pass |
| TC-6MN9 | FR-22 | Given no skill files, then action is not-found | pass |
| TC-FY6S | FR-22 | Given profile MD with injected section, then removes the section | pass |
| TC-142W | FR-22 | Given profile MD without KB section, then action is not-found | pass |
| TC-GZ6C | FR-22 | Given removed results, then formats readable output | pass |
| TC-Q3UB | FR-22 | Given no provider config dirs, then Claude and antigravity-cli are still installed (ensureConfigDir) and others are not-installed | pass |
| TC-WSNX | FR-22 | Given Claude config dir exists with no settings.json, then creates settings.json with hook | pass |
| TC-H2RT | FR-22 | Given hook already installed at current path, then action is skipped | pass |
| TC-EFJ5 | FR-22 | Given hook installed at stale path, then updates to current path | pass |
| TC-HUIJ | FR-22 | Given settings.json with existing hooks, then merges without clobbering | pass |
| TC-K940 | FR-22 | Given Gemini config dir exists, then installs BeforeTool hook in settings.json | pass |
| TC-FQNA | FR-22 | Given Codex config dir exists, then installs hook in hooks.json | pass |
| TC-7FL4 | FR-22 | Writes executable hook script that emits Claude JSON additionalContext | pass |
| TC-A9GC | FR-22 | Given Grep tool input, hook emits additionalContext JSON | pass |
| TC-9K3J | FR-22 | Given Read tool, hook stays silent | pass |
| TC-X73H | FR-22 | Given hook present in settings.json, then removes it | pass |
| TC-NMYF | FR-22 | Given no settings.json, then action is not-installed | pass |
| TC-0RI2 | FR-22 | Given settings.json without KB hook, then action is not-installed | pass |
| TC-FUKU | FR-22 | Given hook plus other hooks in same matcher group, then only removes kb hook | pass |
| TC-QLKQ | FR-22 | includes Agent hooks section when hook results provided | pass |
| TC-N0FO | FR-22 | omits Agent hooks section when hook results not provided | pass |
| TC-V0YM | FR-22 | includes MCP sync section when mcp results provided | pass |
| TC-77QM | FR-22 | includes MCP removals when mcp results provided | pass |
| TC-K60V | FR-23 | greets the user | pass |
| TC-OBCJ | FR-23 | lists the core commands | pass |
| TC-ITA3 | FR-23 | tells the user how to get help | pass |
| TC-LE8B | FR-23 | is a non-empty string | pass |
| TC-RUPU | FR-23 | names the base in the notice | pass |
| TC-RZYR | FR-23 | points the user to server-managed indexing (KB_GIT_REPOS) | pass |
| TC-U1O1 | FR-23 | suggests switching base via kb base use | pass |
| TC-6DBO | FR-23 | reflects the given base name exactly | pass |
| TC-W5CI | FR-24 | Given --help, then prints release-based sync help | pass |
| TC-62DX | FR-24 | Given no flags, then sync downloads and extracts both release runtimes and links stable client/server binaries | pass |
| TC-SPST | FR-24 | Given legacy no-build flag, then sync rejects it | pass |
| TC-8NNM | FR-24 | Given positional args, then sync rejects them | pass |
| TC-3678 | FR-25 | client uninstall removes kb only and preserves kb-server + server data | pass |
| TC-5X7H | FR-25 | removes PATH entries from rc files only when both binaries are gone | pass |
| TC-NMA1 | FR-25 | kb uninstall rejects --purge with kb-server guidance | pass |
| TC-4FS5 | FR-25 | --yes removes client without prompting | pass |
| TC-VGQ5 | FR-25 | kb-server uninstall without purge keeps ~/.kb server data | pass |
| TC-CCMI | FR-25 | kb-server uninstall --purge removes server data but keeps kb client install | pass |
| TC-0XNN | FR-25 | kb-server uninstall --purge --yes deletes server data | pass |
| TC-QU2P | FR-22 | Given non-search Bash commands, hook stays silent | pass |
| TC-CKTA | FR-22 | Given grep only filtering another command output, hook stays silent | pass |
| TC-K3DX | FR-22 | Given repo-search commands in command position, hook fires | pass |
| TC-Z3RK | FR-22 | Given a repeat search in the same session window, hook reminds only once | pass |
| TC-OVJ8 | FR-22 | Given KB_HOOK_REMINDER=false, hook stays silent even for searches | pass |
| TC-DNRX | FR-27 | Given two repos with a colliding repo-relative AST key, then per-slug manifests do not clobber each other and each repo sees its own hashes as unchanged | pass |
| TC-DY09 | FR-27 | Given an undefined slug, then the AST manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-MV4F | FR-28 | Given a prior AST manifest, then diffRemovedAstFiles reports only paths dropped from the current tree | pass |
| TC-EYB6 | FR-27 | Given two repos with a colliding repo-relative source key, then per-slug source manifests do not clobber each other and each repo sees its own content as unchanged | pass |
| TC-WUXM | FR-27 | Given an undefined slug, then the source manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-EWNP | FR-27 | Given a warm rescan of an unchanged multi-repo base, then each repo detects 0 changed and no facts are lost | pass |
| TC-WLSP | FR-28 | Given a changed or deleted file in one repo, then only that repo is reindexed and unchanged files' and sibling repos' facts survive | pass |
| TC-LJAS | FR-29 | Given kb skills install, then registers kb-feedback.sh for Claude PostToolUse, PreToolUse, and Stop | pass |
| TC-DQMM | FR-29 | Given a query PostToolUse event, then records the used marker and stays silent | pass |
| TC-XKAT | FR-29 | Given git push after query use, then injects a submit_feedback reminder pointing at get_feedback_requests | pass |
| TC-MQUO | FR-29 | Given Stop after query use without feedback, then blocks once with a submit_feedback reason | pass |
| TC-88W6 | FR-29 | Given submit_feedback already called or a prior nudge, then push reminder and Stop stay silent | pass |
| TC-BU7Y | FR-29 | Given no query use or KB_FEEDBACK_REMINDER=false, then all feedback events stay silent | pass |
| TC-PBX6 | FR-29 | Given installed feedback hooks, then uninstall removes them from all three Claude events | pass |
| TC-EMS2 | FR-30 | provider throws during synthesis | answerError records kind and stage; results and status preserved |
| TC-F5OB | FR-30 | model returns only whitespace | answerError kind is empty_response |
| TC-8SUG | FR-30 | synthesis succeeds | answer set and no answerError attached |
| TC-ATMS | FR-30 | curator fell back without judging | no note claims the evidence was focused |
| TC-HZ60 | FR-31 | no run reports with a sessionId | returns a friendly "no chat sessions yet" notice |
| TC-M5TH | FR-31 | reports across two sessions | summarizes the most recent session's runs and token totals |
| TC-TP4E | FR-31 | --session prefix selector | selects that session even when it is not the most recent |
| TC-J1JB | FR-31 | unknown --session selector | throws a "Session not found" error |
| TC-1VAP | FR-32 | no skill files present | status report says no agent skills are installed |
| TC-02TH | FR-32 | a skill file present with a stale hash | status report flags that agent as update-available |
| TC-ZY9W | FR-31 | session reports carry transcript turns | renders the concatenated conversation transcript |
| TC-64CG | FR-21 | logs list with no --command | per-turn chat reports are hidden from the listing |
| TC-Q8Q8 | FR-21 | logs list --command chat | chat reports are shown |
| TC-LEYK | FR-21 | logs show on a chat run with turns | renders the turn transcript |
| TC-SKEB | FR-33 | --skip-embed parsing | sets skipEmbeddings true; absent it defaults false |
| TC-EMSK | FR-33 | init with skipEmbeddings | create-embeddings completes without writing any vectors |
| TC-9FQW | FR-33 | scanBaseRepos with skipEmbeddings | skips the embedder for both the per-repo reindex and the trailing embed pass |
| TC-GF34 | FR-12 | [NEW] Given graph --file flag | parser returns file coverage options |
| TC-CF34 | FR-12 | [NEW] path with file-level code_symbol | coverage report shows searchable symbols |
| TC-CS34 | FR-12 | [NEW] code_file_state without searchable rows | GraphCommandError exit non-zero |

### Related docs

- [CLI.md](CLI.md)
- [TUI.md](../core/TUI.md)
