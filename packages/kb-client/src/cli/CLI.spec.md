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
  - ../../../../tests/cli/retrieval-fallback.test.ts
  - ../../../../tests/cli/session-cli.test.ts
  - ../../../../tests/cli/skill-installer.test.ts
  - ../../../../tests/cli/startup-notices.test.ts
  - ../../../../tests/cli/sync-cli.test.ts
  - ../../../../tests/cli/uninstall-cli.test.ts
description: Behavioral specification for CLI Layer
tags: [spec, kb]
timestamp: 2026-08-02T23:10:00Z
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
| FR-4 | Base selection resolves `--base` and the active base; with none set the server default applies |
| FR-5 | Chat REPL delegates to kb-server `/v1/chat`; synthesis helpers stay unit-tested in-client |
| FR-7 | Chat query orchestrator delegates QUERY turns to shared retrieval |
| FR-8 | Chat retrieval refusal surfaces when evidence is insufficient |
| FR-9 | Command reference generation stays in sync with registered commands |
| FR-10 | Init collects source files from configured git targets |
| FR-16 | Facts CLI parses list/read subcommands and retrieval flags |
| FR-17 | Git sync pulls tracked repos and reports sync status |
| FR-18 | Graph CLI exposes code-graph query and summary subcommands |
| FR-19 | Init AST files manifest records parsed symbol files per cycle |
| FR-20 | Init pipeline runs multi-cycle scan, enrichment, and synthesis |
| FR-21 | Init source files manifest tracks cloned repo paths and branches |
| FR-22 | Init source snapshots capture per-cycle file hashes for drift detection |
| FR-23 | Init topic coverage reports document-type coverage gaps |
| FR-24 | Intent CLI parses query envelopes and routes to retrieval |
| FR-25 | KB config loader merges defaults, file config, and env overrides |
| FR-26 | kb.ignore patterns exclude paths from indexing |
| FR-27 | Logs CLI reads structured run reports from the logs directory |
| FR-30 | Retrieval fallback degrades gracefully when deep retrieval fails |
| FR-31 | Skill installer copies bundled skills to agent home directories, installs hooks, and syncs Cursor/Claude/Antigravity MCP `kb` entries to the active connection (localhost default) — opt-in via `kb skills install` / `kb mcp install`; CLI and TUI startup never auto-install skills or rewrite MCP configs. The kb-first reminder hook fires only on repo-search commands in command position (grep/rg/find/…, `git grep`, `kb query` — never VCS/build/cloud tooling or pipeline-filter greps), throttles to one reminder per session per 15-minute window, and honors `KB_HOOK_REMINDER=false` |
| FR-32 | Startup notices print one-time migration and version hints |
| FR-33 | Sync CLI refreshes the split GitHub Release runtimes and rewires stable client/server binary links |
| FR-34 | Client uninstall removes release client layout; server uninstall removes server layout and optional ~/.kb data |
| FR-36 | Connection context (host + base) is printed on CLI banner, TUI status bar, and chat session open |
| FR-37 | Change-detection manifests are isolated per git-repo slug (base-level, surviving `--no-repos` snapshots); a warm rescan of an unchanged multi-repo base detects 0 changed per repo without clobbering sibling repos, so unchanged files are skipped instead of fully re-embedded |
| FR-38 | A partial rescan re-indexes only files whose content hash changed for that repo and tombstones only files removed from that repo since its last manifest — never unchanged files' facts nor another repo's facts |
| FR-39 | End-of-session feedback hook (Claude Code only): `kb skills install` writes `~/.kb/hooks/kb-feedback.sh` and registers it for PostToolUse (kb MCP tools), PreToolUse (Bash), and Stop. It records that the session used query, then reminds the agent **once** to call `get_feedback_requests` and resolve what it returns via `submit_feedback` — at the first command-position `git push`, or by blocking the first Stop as a fallback — staying silent after feedback is submitted, after one nudge, when query was never used, or when `KB_FEEDBACK_REMINDER=false`; `kb skills uninstall` removes the entries from all three events |
| FR-40 | [NEW] Answer synthesis never fails silently: a provider error or an empty completion records a structured `answerError` on the result (retrieval results preserved, `status` still `accepted` so downstream source handling is unaffected) instead of returning an answerless success, and a curator that fell back contributes no research note claiming the evidence was focused |
| FR-41 | Session CLI groups run reports by sessionId and summarizes the most recent (or a named) session, listing each run for `kb logs show` follow-up |
| FR-42 | Bare `kb skills` reports install status per agent (installed / update available / not installed) without writing any files |
| FR-43 | `--skip-embed` on `kb init`/`kb scan` sets `skipEmbeddings` (default `false`); when set, `create-embeddings` completes without writing any vectors, and a multi-repo scan skips the embedder for both the per-repo reindex and the trailing embed pass |

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
| TC-S9NT | FR-4 | migrates legacy session.json into active-base and removes session.json | pass |
| TC-DL0O | FR-4 | ensureOperationalBaseDir migrates legacy repo sqlite into KB home | pass |
| TC-1BXW | FR-4 | ensureOperationalBaseDir migrates legacy KB home base directory into sessions namespace | pass |
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
| TC-FR8X | FR-7 | Given a mocked read_facts result, then returns accepted read_facts IntentResult | pass |
| TC-XMSJ | FR-8 | refuses when no results | pass |
| TC-7HZP | FR-8 | allows when retrieval detail is all-facts:already-in-context even with zero results | pass |
| TC-DICS | FR-8 | refuses when last checkpoint below default min | pass |
| TC-HAF4 | FR-8 | allows when checkpoints missing (no signal) | pass |
| TC-FRW1 | FR-8 | allows when last checkpoint at or above min | pass |
| TC-BN67 | FR-8 | respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE | pass |
| TC-S9Y9 | FR-8 | formats user/assistant pairs and tail-truncates | pass |
| TC-HCJ1 | FR-9 | returns /name in tui mode | pass |
| TC-MT1G | FR-9 | returns kb name in cli mode | pass |
| TC-ELYM | FR-9 | defaults to cli mode | pass |
| TC-5H2Z | FR-9 | handles multi-word names in tui mode | pass |
| TC-YY8L | FR-9 | handles multi-word names in cli mode | pass |
| TC-M14Z | FR-9 | handles names with flags in tui mode | pass |
| TC-5JUI | FR-9 | returns TUI-style intro in tui mode | pass |
| TC-90YV | FR-9 | returns CLI-style intro in cli mode | pass |
| TC-VOUJ | FR-9 | shows /command syntax in tui mode | pass |
| TC-1MJN | FR-9 | shows kb command syntax in cli mode | pass |
| TC-BSGC | FR-9 | accepts valid modes without type error | pass |
| TC-BXL6 | FR-10 | walks deeply nested directories without stopping early | pass |
| TC-FJPI | FR-10 | collects more than 100 markdown files (no file-count cap) | pass |
| TC-DS1Q | FR-10 | skips dotfile directories | pass |
| TC-KCDP | FR-10 | skips excluded directories like node_modules | pass |
| TC-C7OX | FR-10 | explores sibling directories at the same depth | pass |
| TC-HGQ6 | FR-10 | respects an ignore matcher (prunes dirs and files) | pass |
| TC-V4XI | FR-16 | Given list subcommand, then parses limit and base | pass |
| TC-48JA | FR-16 | Given --help, then throws FactsCommandError exit 0 | pass |
| TC-PJMI | FR-16 | Given search without query, then throws | pass |
| TC-F2GY | FR-16 | Given seeded facts, list and search return human text | pass |
| TC-QQAV | FR-16 | Given fact id, show returns that row | pass |
| TC-NYZ4 | FR-17 | derives name from https URL with .git suffix | pass |
| TC-76VJ | FR-17 | derives name from https URL without .git suffix | pass |
| TC-H1NA | FR-17 | derives name from https URL with trailing slash | pass |
| TC-KXS2 | FR-17 | derives name from ssh URL | pass |
| TC-XVFS | FR-17 | lowercases the result | pass |
| TC-G8ZP | FR-17 | replaces special characters (but keeps underscore, dot, dash) with dashes | pass |
| TC-4IUC | FR-17 | Given no branch, then clones the remote default branch | pass |
| TC-UOHK | FR-17 | Given an explicit branch, then clones that branch | pass |
| TC-40R5 | FR-17 | disables interactive git prompts even without a token | pass |
| TC-JAHP | FR-17 | uses GITHUB_TOKEN when present | pass |
| TC-IEOG | FR-17 | falls back to GH_TOKEN when GITHUB_TOKEN is absent | pass |
| TC-YE33 | FR-17 | prefers GITHUB_TOKEN over GH_TOKEN when both are present | pass |
| TC-H95Q | FR-17 | Given a dirty .kb marker in the clone, then pull succeeds | pass |
| TC-FDTH | FR-17 | Given dirty tracked files and no new remote commits, then pull discards local edits | pass |
| TC-9YYO | FR-17 | Given dirty tracked files and new remote commits, then pull succeeds | pass |
| TC-VPTT | FR-17 | clones a repo whose default branch is master without specifying a branch | pass |
| TC-YCUC | FR-17 | honors an explicitly requested branch | pass |
| TC-OOKL | FR-18 | Given graph help flag, then parser returns graph-specific help text | pass |
| TC-UIFR | FR-18 | Given graph entity flag, then parser returns entity lookup options | pass |
| TC-P5RI | FR-18 | Given graph path flag, then parser returns path lookup options | pass |
| TC-KY82 | FR-18 | Given graph format flag, then parser returns export format option | pass |
| TC-BY2A | FR-18 | prints grouped graph usage and examples | pass |
| TC-R3PD | FR-18 | routes default summary output through the out parameter, not console.log | pass |
| TC-5W5H | FR-18 | routes --format dot output through the out parameter | pass |
| TC-I5DI | FR-18 | routes --format json output through the out parameter | pass |
| TC-8UAF | FR-18 | reports no-path-found through the out parameter | pass |
| TC-HNK2 | FR-18 | reports no matching documents/symbols through the out parameter | pass |
| TC-BF7T | FR-19 | returns null diff when no manifest exists yet (first run) | pass |
| TC-A9HB | FR-19 | round-trips manifest writes and detects changed/new files only | pass |
| TC-W75I | FR-19 | treats unchanged contents as a no-op diff | pass |
| TC-I5B9 | FR-20 | Given init without --base, then it prompts for a base name and uses the answer | pass |
| TC-UBCD | FR-20 | Given init without --base and config activeBase, then prompt suggests the first git remote slug | pass |
| TC-KWC3 | FR-20 | Given detach and resume flags, then parses them into init options | pass |
| TC-4MNE | FR-20 | Given scan args, then parsing implies rescan and always applies automatically | pass |
| TC-PI4H | FR-20 | Given --stop-after document-facts, then parsing returns document-facts | pass |
| TC-HOLS | FR-20 | Given init cycle validation, then exactly 5 phases are defined without pass-graph | pass |
| TC-S6XJ | FR-20 | Given a custom progress sink, then init progress updates route there instead of writing directly to stderr | pass |
| TC-6HEV | FR-20 | Given interactive init, then read-inputs does not ask deprecated interview questions | pass |
| TC-3OB0 | FR-20 | Given resume after import-docs pause, then finishes init without re-asking read-inputs | pass |
| TC-YNOA | FR-20 | Given version 1 checkpoint, then resume migrates it to version 3 without reviving deprecated answers | pass |
| TC-IUR0 | FR-20 | Given detach during read-inputs, then init no longer stores pending interview questions | pass |
| TC-R6KG | FR-20 | Given legacy tmp checkpoint path, then init migrates it into KB home checkpoints | pass |
| TC-30HB | FR-20 | Given resume after read-inputs, then deprecated interview prompting does not resume | pass |
| TC-ND14 | FR-20 | Given several repo markdown files, then import-docs checkpoint lists each as original | pass |
| TC-0GAD | FR-20 | Given rescan, then read-inputs loads all markdown sources under cwd | pass |
| TC-IOJ4 | FR-20 | Given published snapshot docs, then read-inputs excludes published snapshots and export artifacts | pass |
| TC-YC8E | FR-20 | Given no markdown sources under the working directory, then document-facts stage is skipped | pass |
| TC-HBHQ | FR-20 | Given multiple markdown sources, then iterable init phases emit current-item progress | pass |
| TC-1NBT | FR-20 | Given rescan, then write cycle writes originals and any resulting mutations | pass |
| TC-5HX5 | FR-20 | Given rescan, then run writes refreshed documents instead of staying plan-only | pass |
| TC-GRLA | FR-20 | Given an unchanged second scan, then markdown sources are skipped and no original docs are rewritten | pass |
| TC-0KMZ | FR-20 | Given one changed markdown source on rescan, then only that original doc is re-imported | pass |
| TC-9Z33 | FR-20 | Given unchanged scan plan, then it does not emit preview diff chatter or synthetic scan files | pass |
| TC-H1FQ | FR-20 | Given interactive rescan, then read-inputs does not ask initial interview questions or prompt to proceed | pass |
| TC-Z054 | FR-20 | Given interactive rescan through import-docs, then follow-up interview questions are skipped without a proceed prompt | pass |
| TC-5FAE | FR-20 | Given rescan with an active base, uses it in non-interactive mode | pass |
| TC-3SGG | FR-20 | Given rescan without --base and no selected base in non-interactive mode, throws guidance | pass |
| TC-QNA6 | FR-20 | Given a full init cycle, then progress counter shows 3/3 (not more) | pass |
| TC-0R0B | FR-20 | Given a TypeScript-only project, then AST code-index uses no LLM tokens | pass |
| TC-O8A2 | FR-20 | Given an active base, uses it without prompting | pass |
| TC-V7E7 | FR-20 | Given --base flag, uses it directly without prompting | pass |
| TC-D5NZ | FR-20 | Given no selected base and a single initialized base, auto-selects it without prompting | pass |
| TC-I656 | FR-20 | Given no selected base and multiple bases, prompts with a list and accepts a typed name | pass |
| TC-GOHJ | FR-20 | Given no selected base and multiple bases, passing suggestions list to askQuestion | pass |
| TC-D7OQ | FR-20 | Given no selected base and multiple bases, an invalid name throws an error | pass |
| TC-XNCG | FR-20 | Given no selected base and /cancel answer, throws InitCancelledError | pass |
| TC-01FX | FR-20 | Given no selected base and no initialized bases, throws a helpful error | pass |
| TC-ZG04 | FR-20 | Given no selected base and --non-interactive, throws without prompting | pass |
| TC-GM0N | FR-20 | Given interactive init with a git URL entered first, then clones from that URL | pass |
| TC-PONX | FR-20 | Given --git flag (non-interactive), then clones the repo onto the base volume | pass |
| TC-PGIR | FR-20 | Given --git without branch, then clones the remote default branch | pass |
| TC-UIOI | FR-20 | Given multiple --git targets, then both repos index into one base and the volume lists both | pass |
| TC-HHLH | FR-20 | Given /cancel at git URL prompt, throws InitCancelledError | pass |
| TC-1L81 | FR-20 | Given non-interactive init without --git, throws requiring a git remote | pass |
| TC-2B4D | FR-20 | Given interactive init with empty git answer then /cancel, throws InitCancelledError | pass |
| TC-YYVU | FR-20 | parseInitCommand parses --git and --branch flags | pass |
| TC-98OW | FR-20 | parseInitCommand parses repeatable --git with inline branch (no branch = remote default) | pass |
| TC-TIUI | FR-20 | parseInitCommand with only --git leaves the branch undefined (remote default) | pass |
| TC-7SME | FR-21 | returns null diff when no manifest exists yet (first run) | pass |
| TC-NO8M | FR-21 | round-trips manifest writes and detects changed/new source files only | pass |
| TC-3M1Y | FR-21 | detects source files removed since the last manifest | pass |
| TC-263O | FR-21 | treats unchanged contents as a no-op diff | pass |
| TC-X447 | FR-22 | Given many autogen-only docs and several source files, then append adds frozen originals per file | pass |
| TC-KPPY | FR-22 | Given an original shard already exists for a file title, then append does not duplicate that file | pass |
| TC-60ET | FR-22 | Given README path, then isInitReadmeHomePath is true only for readme.md basename | pass |
| TC-QEKE | FR-22 | Given oversized file body, then snapshot content is clipped with truncation marker | pass |
| TC-UIF4 | FR-23 | Given grounded source, user answers, and draft docs, then marks topic sufficient | pass |
| TC-XDJ9 | FR-23 | Given contradictory deployment signals, then surfaces unresolved contradiction gap | pass |
| TC-XHOG | FR-23 | Given weak non-interactive evidence, then marks topic inferred and summarizes unresolved topics | pass |
| TC-D5E3 | FR-24 | parses query flags and query session support | pass |
| TC-L7KC | FR-24 | rejects unknown public commands | pass |
| TC-A5U9 | FR-24 | only treats query as an intent command | pass |
| TC-U3RI | FR-24 | formats read_facts results in human mode | pass |
| TC-J2NW | FR-24 | prints minimal intent help with only the supported commands | pass |
| TC-M8QE | FR-24 | renders orchestration footer through printer helpers | pass |
| TC-313O | FR-24 | prints non-read_facts results without treating them as query results | pass |
| TC-66OY | FR-24 | derives query evidence from retrieval checkpoints instead of a fixed router default | pass |
| TC-6EBP | FR-24 | keeps query rewrite/session fallback scoped to query only | pass |
| TC-VEKI | FR-24 | enriches query answers with the LLM | pass |
| TC-9PCT | FR-24 | replaces insufficient LLM answer with deterministic fallback from documents | pass |
| TC-Y4EF | FR-24 | keeps long sufficient LLM answer unchanged | pass |
| TC-SYH8 | FR-24 | forces build/config scaffold when answer lacks required sections | pass |
| TC-5XBS | FR-24 | keeps LLM answer when synthesisQuestion is pre-expansion text (not graph-expanded query) | pass |
| TC-8JL6 | FR-24 | query synthesis allows a larger answer output budget | pass |
| TC-RFFQ | FR-25 | returns default features when no env is set | pass |
| TC-HAQH | FR-25 | migrates legacy config.json base fields into line files | pass |
| TC-ZLRD | FR-25 | reads server profile from KB_HOST/KB_PORT env | pass |
| TC-VE4A | FR-25 | returns config with default features enabled | pass |
| TC-VVB1 | FR-25 | matches readKbConfig output | pass |
| TC-YAO2 | FR-25 | returns fresh config with defaults | pass |
| TC-OBQU | FR-25 | returns false when no LLM env vars are set | pass |
| TC-F4WQ | FR-25 | returns true when ANTHROPIC_API_KEY is set | pass |
| TC-43MO | FR-25 | throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set | pass |
| TC-VBAH | FR-25 | does not throw for ollama (no key required) | pass |
| TC-S6MY | FR-25 | prefers env var when provider is declared | pass |
| TC-2OBO | FR-25 | auto-detects provider from env vars when no provider is declared | pass |
| TC-TCBY | FR-25 | falls back to ollama when nothing is configured | pass |
| TC-D2EE | FR-25 | supported config paths omit base-selection keys | pass |
| TC-RW4A | FR-25 | resolveFactRetrievalMethod defaults to query_expansion | pass |
| TC-DBOL | FR-25 | KB_FACT_RETRIEVAL_METHOD env override wins | pass |
| TC-VV3K | FR-25 | gemini model override preserved in provider resolution | pass |
| TC-MA96 | FR-25 | returns inferred provider notice when llm.provider is unset and env key exists | pass |
| TC-PXZA | FR-25 | does not infer when KB_LLM_PROVIDER is already set | pass |
| TC-7GUG | FR-25 | KB_LLM_PROVIDER env wins over auto-detect | pass |
| TC-PNB4 | FR-25 | preserves createdAt on round-trip | pass |
| TC-672C | FR-25 | normalizes in memory without writing files | pass |
| TC-YKLS | FR-26 | splits on commas and newlines and trims | pass |
| TC-8974 | FR-26 | drops empties | pass |
| TC-CW5F | FR-26 | trims, removes blanks, and de-duplicates preserving order | pass |
| TC-RLP3 | FR-26 | matches bare names by basename at any depth | pass |
| TC-CGCH | FR-26 | anchors patterns that contain a slash | pass |
| TC-23SQ | FR-26 | honours a leading slash anchor | pass |
| TC-XXFU | FR-26 | trailing slash matches directories only (but still ignores their contents) | pass |
| TC-J1ZX | FR-26 | supports * within a segment and ** across segments | pass |
| TC-ASZ5 | FR-26 | supports negation to re-include | pass |
| TC-JAOO | FR-26 | skips comments and blank lines | pass |
| TC-E3LJ | FR-26 | an empty matcher ignores nothing | pass |
| TC-X1KF | FR-26 | normalizes backslashes and leading ./ in the tested path | pass |
| TC-0IEO | FR-26 | parses KB_SERVER_IGNORE (comma/newline separated) into patterns | pass |
| TC-2MJJ | FR-26 | returns [] when KB_SERVER_IGNORE is unset or empty | pass |
| TC-M270 | FR-27 | includes all three subcommands | pass |
| TC-DY6B | FR-27 | documents --since flag | pass |
| TC-JT0R | FR-27 | documents --base flag | pass |
| TC-EWYB | FR-27 | Given no reports, then returns empty message | pass |
| TC-NS1S | FR-27 | Given reports, then list includes run ID, command, and duration | pass |
| TC-KRVK | FR-27 | Given --command filter, then only matching command appears | pass |
| TC-AF3S | FR-27 | Given --limit 1, then only one row appears | pass |
| TC-HOOL | FR-27 | Given a known runId, then displays stage table | pass |
| TC-FW97 | FR-27 | Given a prefix of runId, then matches by prefix | pass |
| TC-6V8G | FR-27 | Given unknown runId, then throws not found error | pass |
| TC-MK1V | FR-27 | Given show with no runId, then throws usage error | pass |
| TC-9ZCQ | FR-27 | Given two init runs, then compare output contains stage names and deltas | pass |
| TC-UGJT | FR-27 | Given compare with --command init, then uses only init runs | pass |
| TC-CAJD | FR-27 | Given explicit runIds, then compares those two runs | pass |
| TC-JR55 | FR-27 | Given fewer than 2 runs, then throws with helpful message | pass |
| TC-T8GK | FR-27 | Given two runs with different stage sets, then union of stages appears in output | pass |
| TC-22AT | FR-27 | Given compare output totals row, then Δms matches difference between runs | pass |
| TC-T2JO | FR-27 | Given --base filter, then only reports matching that base appear | pass |
| TC-KZH2 | FR-27 | Given --base filter that matches nothing, then returns empty message | pass |
| TC-XQ5Q | FR-27 | Given --base combined with --command, then both filters apply | pass |
| TC-7I6G | FR-27 | Given --base filter, then compare uses only runs from that base | pass |
| TC-7AE2 | FR-27 | Given no subcommand, then returns help text | pass |
| TC-R6T4 | FR-27 | Given --help, then returns help text | pass |
| TC-1207 | FR-27 | Given unknown subcommand, then throws with the subcommand name | pass |
| TC-J09B | FR-30 | Given more than TOP_SOURCE_PREVIEW_LIMIT cited files, then footer says top N of M file(s) | pass |
| TC-XOR5 | FR-30 | Given at most TOP_SOURCE_PREVIEW_LIMIT files, then footer says all M file(s), folding symbols | pass |
| TC-5JE4 | FR-30 | Given no openable hits (incl. dropped fact:// refs), then footer is (none) | pass |
| TC-K98I | FR-31 | Given no existing skill files, then installs all agents and returns installed actions | pass |
| TC-PSA0 | FR-31 | Given already-installed skill with matching hash, then action is skipped | pass |
| TC-CHPS | FR-31 | Given stale skill hash, then action is updated | pass |
| TC-LGZ9 | FR-31 | Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb | pass |
| TC-IDPC | FR-31 | Given ~/.claude/CLAUDE.md already has KB section, then action is already-present | pass |
| TC-JK6H | FR-31 | Given ~/.codex/AGENTS.md exists without KB section, then injects blurb | pass |
| TC-DY3P | FR-31 | Given neither profile MD exists, then creates ~/.claude/CLAUDE.md | pass |
| TC-IXDI | FR-31 | Given both profile MDs exist, then only injects into whichever lacks the section | pass |
| TC-83WT | FR-31 | shows installed skill files and injected profile entries | pass |
| TC-8ZFW | FR-31 | shows skipped skill files as up-to-date | pass |
| TC-2K9N | FR-31 | Given installed skill files, then removes them and reports removed | pass |
| TC-6MN9 | FR-31 | Given no skill files, then action is not-found | pass |
| TC-FY6S | FR-31 | Given profile MD with injected section, then removes the section | pass |
| TC-142W | FR-31 | Given profile MD without KB section, then action is not-found | pass |
| TC-GZ6C | FR-31 | Given removed results, then formats readable output | pass |
| TC-Q3UB | FR-31 | Given no provider config dirs, then Claude and antigravity-cli are still installed (ensureConfigDir) and others are not-installed | pass |
| TC-WSNX | FR-31 | Given Claude config dir exists with no settings.json, then creates settings.json with hook | pass |
| TC-H2RT | FR-31 | Given hook already installed at current path, then action is skipped | pass |
| TC-EFJ5 | FR-31 | Given hook installed at stale path, then updates to current path | pass |
| TC-HUIJ | FR-31 | Given settings.json with existing hooks, then merges without clobbering | pass |
| TC-K940 | FR-31 | Given Gemini config dir exists, then installs BeforeTool hook in settings.json | pass |
| TC-FQNA | FR-31 | Given Codex config dir exists, then installs hook in hooks.json | pass |
| TC-7FL4 | FR-31 | Writes executable hook script that emits Claude JSON additionalContext | pass |
| TC-A9GC | FR-31 | Given Grep tool input, hook emits additionalContext JSON | pass |
| TC-9K3J | FR-31 | Given Read tool, hook stays silent | pass |
| TC-X73H | FR-31 | Given hook present in settings.json, then removes it | pass |
| TC-NMYF | FR-31 | Given no settings.json, then action is not-installed | pass |
| TC-0RI2 | FR-31 | Given settings.json without KB hook, then action is not-installed | pass |
| TC-FUKU | FR-31 | Given hook plus other hooks in same matcher group, then only removes kb hook | pass |
| TC-QLKQ | FR-31 | includes Agent hooks section when hook results provided | pass |
| TC-N0FO | FR-31 | omits Agent hooks section when hook results not provided | pass |
| TC-V0YM | FR-31 | includes MCP sync section when mcp results provided | pass |
| TC-77QM | FR-31 | includes MCP removals when mcp results provided | pass |
| TC-K60V | FR-32 | greets the user | pass |
| TC-OBCJ | FR-32 | lists the core commands | pass |
| TC-ITA3 | FR-32 | tells the user how to get help | pass |
| TC-LE8B | FR-32 | is a non-empty string | pass |
| TC-RUPU | FR-32 | names the base in the notice | pass |
| TC-RZYR | FR-32 | points the user to server-managed indexing (KB_GIT_REPOS) | pass |
| TC-U1O1 | FR-32 | suggests switching base via kb base use | pass |
| TC-6DBO | FR-32 | reflects the given base name exactly | pass |
| TC-W5CI | FR-33 | Given --help, then prints release-based sync help | pass |
| TC-62DX | FR-33 | Given no flags, then sync downloads and extracts both release runtimes and links stable client/server binaries | pass |
| TC-SPST | FR-33 | Given legacy no-build flag, then sync rejects it | pass |
| TC-8NNM | FR-33 | Given positional args, then sync rejects them | pass |
| TC-3678 | FR-34 | client uninstall removes kb only and preserves kb-server + server data | pass |
| TC-5X7H | FR-34 | removes PATH entries from rc files only when both binaries are gone | pass |
| TC-NMA1 | FR-34 | kb uninstall rejects --purge with kb-server guidance | pass |
| TC-4FS5 | FR-34 | --yes removes client without prompting | pass |
| TC-VGQ5 | FR-34 | kb-server uninstall without purge keeps ~/.kb server data | pass |
| TC-CCMI | FR-34 | kb-server uninstall --purge removes server data but keeps kb client install | pass |
| TC-0XNN | FR-34 | kb-server uninstall --purge --yes deletes server data | pass |
| TC-QU2P | FR-31 | Given non-search Bash commands, hook stays silent | pass |
| TC-CKTA | FR-31 | Given grep only filtering another command output, hook stays silent | pass |
| TC-K3DX | FR-31 | Given repo-search commands in command position, hook fires | pass |
| TC-Z3RK | FR-31 | Given a repeat search in the same session window, hook reminds only once | pass |
| TC-OVJ8 | FR-31 | Given KB_HOOK_REMINDER=false, hook stays silent even for searches | pass |
| TC-DNRX | FR-37 | Given two repos with a colliding repo-relative AST key, then per-slug manifests do not clobber each other and each repo sees its own hashes as unchanged | pass |
| TC-DY09 | FR-37 | Given an undefined slug, then the AST manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-MV4F | FR-38 | Given a prior AST manifest, then diffRemovedAstFiles reports only paths dropped from the current tree | pass |
| TC-EYB6 | FR-37 | Given two repos with a colliding repo-relative source key, then per-slug source manifests do not clobber each other and each repo sees its own content as unchanged | pass |
| TC-WUXM | FR-37 | Given an undefined slug, then the source manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-EWNP | FR-37 | Given a warm rescan of an unchanged multi-repo base, then each repo detects 0 changed and no facts are lost | pass |
| TC-WLSP | FR-38 | Given a changed or deleted file in one repo, then only that repo is reindexed and unchanged files' and sibling repos' facts survive | pass |
| TC-LJAS | FR-39 | Given kb skills install, then registers kb-feedback.sh for Claude PostToolUse, PreToolUse, and Stop | pass |
| TC-DQMM | FR-39 | Given a query PostToolUse event, then records the used marker and stays silent | pass |
| TC-XKAT | FR-39 | Given git push after query use, then injects a submit_feedback reminder pointing at get_feedback_requests | pass |
| TC-MQUO | FR-39 | Given Stop after query use without feedback, then blocks once with a submit_feedback reason | pass |
| TC-88W6 | FR-39 | Given submit_feedback already called or a prior nudge, then push reminder and Stop stay silent | pass |
| TC-BU7Y | FR-39 | Given no query use or KB_FEEDBACK_REMINDER=false, then all feedback events stay silent | pass |
| TC-PBX6 | FR-39 | Given installed feedback hooks, then uninstall removes them from all three Claude events | pass |
| TC-EMS2 | FR-40 | provider throws during synthesis | answerError records kind and stage; results and status preserved |
| TC-F5OB | FR-40 | model returns only whitespace | answerError kind is empty_response |
| TC-8SUG | FR-40 | synthesis succeeds | answer set and no answerError attached |
| TC-ATMS | FR-40 | curator fell back without judging | no note claims the evidence was focused |
| TC-HZ60 | FR-41 | no run reports with a sessionId | returns a friendly "no chat sessions yet" notice |
| TC-M5TH | FR-41 | reports across two sessions | summarizes the most recent session's runs and token totals |
| TC-TP4E | FR-41 | --session prefix selector | selects that session even when it is not the most recent |
| TC-J1JB | FR-41 | unknown --session selector | throws a "Session not found" error |
| TC-1VAP | FR-42 | no skill files present | status report says no agent skills are installed |
| TC-02TH | FR-42 | a skill file present with a stale hash | status report flags that agent as update-available |
| TC-ZY9W | FR-41 | session reports carry transcript turns | renders the concatenated conversation transcript |
| TC-64CG | FR-27 | logs list with no --command | per-turn chat reports are hidden from the listing |
| TC-Q8Q8 | FR-27 | logs list --command chat | chat reports are shown |
| TC-LEYK | FR-27 | logs show on a chat run with turns | renders the turn transcript |
| TC-SKEB | FR-43 | --skip-embed parsing | sets skipEmbeddings true; absent it defaults false |
| TC-EMSK | FR-43 | init with skipEmbeddings | create-embeddings completes without writing any vectors |
| TC-9FQW | FR-43 | scanBaseRepos with skipEmbeddings | skips the embedder for both the per-repo reindex and the trailing embed pass |

### Related docs

- [CLI.md](CLI.md)
- [TUI.md](../core/TUI.md)
