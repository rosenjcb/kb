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

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | Given no clones on the volume, then no-ops and returns 0 | pass |
| TC-2 | FR-1 | Given a repo with no new commits, then pulls but does not re-index | pass |
| TC-3 | FR-1 | Given a repo with new commits, then pulls and re-indexes that repo by slug | pass |
| TC-4 | FR-1 | Given multiple repos, then only the changed repo is re-indexed | pass |
| TC-5 | FR-1 | Given one repo's pull fails, then the other repos still sync | pass |
| TC-6 | FR-2 | Given kb base use <base>, then sets activeBase and prints resolved path | pass |
| TC-8 | FR-2 | Given kb base use <base> that does not exist, then errors with server-managed guidance | pass |
| TC-9 | FR-2 | Given kb base use --show, then prints current base config | pass |
| TC-10 | FR-2 | Given kb base --help, then prints base help pointing deletion at the server | pass |
| TC-11 | FR-2 | Given kb base list, then forwards to runRemoteCliCommand | pass |
| TC-12 | FR-2 | Given kb base delete, then refuses client-side and does not forward to the server | pass |
| TC-13 | FR-2 | Given base delete in the TUI, then refuses client-side and does not forward | pass |
| TC-14 | FR-2 | Given kb --help, then prints --host and core commands | pass |
| TC-15 | FR-3 | returns [] when the repos/ dir is absent | pass |
| TC-16 | FR-3 | lists each git clone under repos/, deriving slug + dir from the layout | pass |
| TC-17 | FR-3 | skips non-git directories under repos/ | pass |
| TC-18 | FR-3 | repoSlugFromGitUrl handles https, ssh, and local paths | pass |
| TC-19 | FR-3 | repoDirForSlug nests clones under repos/ | pass |
| TC-20 | FR-4 | alias base resolves to namespaced sessions directory | pass |
| TC-21 | FR-4 | path-like base resolves relative to cwd | pass |
| TC-22 | FR-4 | absolute path base is returned as-is | pass |
| TC-23 | FR-4 | resolves the active base from config | pass |
| TC-25 | FR-4 | throws when no activeBase is set (server default takes over) | pass |
| TC-28 | FR-4 | writeSessionBase persists the active base | pass |
| TC-29 | FR-4 | migrates legacy session.json into active-base and removes session.json | pass |
| TC-30 | FR-4 | ensureOperationalBaseDir migrates legacy repo sqlite into KB home | pass |
| TC-31 | FR-4 | ensureOperationalBaseDir migrates legacy KB home base directory into sessions namespace | pass |
| TC-32 | FR-4 | formatUseCommandHelp shows active session switching | pass |
| TC-36 | FR-4 | Given an existing named base, then deletes its session directory | pass |
| TC-37 | FR-4 | Given legacy + tmp checkpoint artifacts, then purges them too | pass |
| TC-38 | FR-4 | Given the base is the active base, then clears it from config | pass |
| TC-40 | FR-4 | Given the base does not exist on disk, then succeeds without error | pass |
| TC-41 | FR-4 | Given a path-like base, then throws rather than deleting arbitrary paths | pass |
| TC-44 | FR-4 | includes the base name and path in output | pass |
| TC-45 | FR-4 | mentions cleared active base when applicable | pass |
| TC-54 | FR-4 | returns empty array when sessions directory does not exist | pass |
| TC-55 | FR-4 | returns only directories that contain .kb-index.sqlite | pass |
| TC-56 | FR-4 | marks the active base correctly | pass |
| TC-57 | FR-4 | returns bases sorted alphabetically | pass |
| TC-60 | FR-4 | resolves the configured active base | pass |
| TC-61 | FR-4 | throws when no active base is configured | pass |
| TC-63 | FR-4 | readOptionalCliValue returns the following token | pass |
| TC-64 | FR-4 | readOptionalCliValue returns undefined when flag or value is missing | pass |
| TC-65 | FR-4 | stripCliFlagWithValue removes --base and its value | pass |
| TC-66 | FR-4 | resolveKbStorageDirFromArgs honors --base over active session | pass |
| TC-67 | FR-4 | resolveKbStorageDirFromArgs falls back to effective base when --base omitted | pass |
| TC-68 | FR-5 | Given chat help printer, then returns grouped usage and interactive commands including /clear | pass |
| TC-69 | FR-5 | Given evidence and question, then turn content includes evidence block and question without embedded history | pass |
| TC-70 | FR-5 | Given long retrieved fact bodies, then turn content truncates each fact for synthesis | pass |
| TC-71 | FR-5 | Given runChatSession, then delegates to runRemoteChatSession | pass |
| TC-72 | FR-5 | Given retrieval provided, then synthesizes answer from pre-fetched context without extra retrieval | pass |
| TC-73 | FR-5 | Given multi-round loop, then calls query_kb in parallel and populates lastIntentResult | pass |
| TC-74 | FR-5 | Given retrieval undefined (chat path), then starts loop from provided messages directly | pass |
| TC-76 | FR-7 | Given a mocked read_facts result, then returns accepted read_facts IntentResult | pass |
| TC-77 | FR-8 | refuses when no results | pass |
| TC-78 | FR-8 | allows when retrieval detail is all-facts:already-in-context even with zero results | pass |
| TC-79 | FR-8 | refuses when last checkpoint below default min | pass |
| TC-80 | FR-8 | allows when checkpoints missing (no signal) | pass |
| TC-81 | FR-8 | allows when last checkpoint at or above min | pass |
| TC-82 | FR-8 | respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE | pass |
| TC-83 | FR-8 | formats user/assistant pairs and tail-truncates | pass |
| TC-84 | FR-9 | returns /name in tui mode | pass |
| TC-85 | FR-9 | returns kb name in cli mode | pass |
| TC-86 | FR-9 | defaults to cli mode | pass |
| TC-87 | FR-9 | handles multi-word names in tui mode | pass |
| TC-88 | FR-9 | handles multi-word names in cli mode | pass |
| TC-89 | FR-9 | handles names with flags in tui mode | pass |
| TC-90 | FR-9 | returns TUI-style intro in tui mode | pass |
| TC-91 | FR-9 | returns CLI-style intro in cli mode | pass |
| TC-92 | FR-9 | shows /command syntax in tui mode | pass |
| TC-93 | FR-9 | shows kb command syntax in cli mode | pass |
| TC-94 | FR-9 | accepts valid modes without type error | pass |
| TC-95 | FR-10 | walks deeply nested directories without stopping early | pass |
| TC-96 | FR-10 | collects more than 100 markdown files (no file-count cap) | pass |
| TC-97 | FR-10 | skips dotfile directories | pass |
| TC-98 | FR-10 | skips excluded directories like node_modules | pass |
| TC-99 | FR-10 | explores sibling directories at the same depth | pass |
| TC-100 | FR-10 | respects an ignore matcher (prunes dirs and files) | pass |
| TC-161 | FR-16 | Given list subcommand, then parses limit and base | pass |
| TC-162 | FR-16 | Given --help, then throws FactsCommandError exit 0 | pass |
| TC-163 | FR-16 | Given search without query, then throws | pass |
| TC-164 | FR-16 | Given seeded facts, list and search return human text | pass |
| TC-165 | FR-16 | Given fact id, show returns that row | pass |
| TC-166 | FR-17 | derives name from https URL with .git suffix | pass |
| TC-167 | FR-17 | derives name from https URL without .git suffix | pass |
| TC-168 | FR-17 | derives name from https URL with trailing slash | pass |
| TC-169 | FR-17 | derives name from ssh URL | pass |
| TC-170 | FR-17 | lowercases the result | pass |
| TC-171 | FR-17 | replaces special characters (but keeps underscore, dot, dash) with dashes | pass |
| TC-172 | FR-17 | Given no branch, then clones the remote default branch | pass |
| TC-173 | FR-17 | Given an explicit branch, then clones that branch | pass |
| TC-174 | FR-17 | disables interactive git prompts even without a token | pass |
| TC-175 | FR-17 | uses GITHUB_TOKEN when present | pass |
| TC-176 | FR-17 | falls back to GH_TOKEN when GITHUB_TOKEN is absent | pass |
| TC-177 | FR-17 | prefers GITHUB_TOKEN over GH_TOKEN when both are present | pass |
| TC-178 | FR-17 | Given a dirty .kb marker in the clone, then pull succeeds | pass |
| TC-179 | FR-17 | Given dirty tracked files and no new remote commits, then pull discards local edits | pass |
| TC-180 | FR-17 | Given dirty tracked files and new remote commits, then pull succeeds | pass |
| TC-181 | FR-17 | clones a repo whose default branch is master without specifying a branch | pass |
| TC-182 | FR-17 | honors an explicitly requested branch | pass |
| TC-183 | FR-18 | Given graph help flag, then parser returns graph-specific help text | pass |
| TC-184 | FR-18 | Given graph entity flag, then parser returns entity lookup options | pass |
| TC-185 | FR-18 | Given graph path flag, then parser returns path lookup options | pass |
| TC-186 | FR-18 | Given graph format flag, then parser returns export format option | pass |
| TC-187 | FR-18 | prints grouped graph usage and examples | pass |
| TC-188 | FR-18 | routes default summary output through the out parameter, not console.log | pass |
| TC-189 | FR-18 | routes --format dot output through the out parameter | pass |
| TC-190 | FR-18 | routes --format json output through the out parameter | pass |
| TC-191 | FR-18 | reports no-path-found through the out parameter | pass |
| TC-192 | FR-18 | reports no matching documents/symbols through the out parameter | pass |
| TC-193 | FR-19 | returns null diff when no manifest exists yet (first run) | pass |
| TC-194 | FR-19 | round-trips manifest writes and detects changed/new files only | pass |
| TC-195 | FR-19 | treats unchanged contents as a no-op diff | pass |
| TC-196 | FR-20 | Given init without --base, then it prompts for a base name and uses the answer | pass |
| TC-197 | FR-20 | Given init without --base and config activeBase, then prompt suggests the first git remote slug | pass |
| TC-198 | FR-20 | Given detach and resume flags, then parses them into init options | pass |
| TC-199 | FR-20 | Given scan args, then parsing implies rescan and always applies automatically | pass |
| TC-200 | FR-20 | Given --stop-after document-facts, then parsing returns document-facts | pass |
| TC-201 | FR-20 | Given init cycle validation, then exactly 5 phases are defined without pass-graph | pass |
| TC-202 | FR-20 | Given a custom progress sink, then init progress updates route there instead of writing directly to stderr | pass |
| TC-203 | FR-20 | Given interactive init, then read-inputs does not ask deprecated interview questions | pass |
| TC-204 | FR-20 | Given resume after import-docs pause, then finishes init without re-asking read-inputs | pass |
| TC-205 | FR-20 | Given version 1 checkpoint, then resume migrates it to version 3 without reviving deprecated answers | pass |
| TC-206 | FR-20 | Given detach during read-inputs, then init no longer stores pending interview questions | pass |
| TC-207 | FR-20 | Given legacy tmp checkpoint path, then init migrates it into KB home checkpoints | pass |
| TC-208 | FR-20 | Given resume after read-inputs, then deprecated interview prompting does not resume | pass |
| TC-209 | FR-20 | Given several repo markdown files, then import-docs checkpoint lists each as original | pass |
| TC-210 | FR-20 | Given rescan, then read-inputs loads all markdown sources under cwd | pass |
| TC-211 | FR-20 | Given published snapshot docs, then read-inputs excludes published snapshots and export artifacts | pass |
| TC-212 | FR-20 | Given no markdown sources under the working directory, then document-facts stage is skipped | pass |
| TC-213 | FR-20 | Given multiple markdown sources, then iterable init phases emit current-item progress | pass |
| TC-214 | FR-20 | Given rescan, then write cycle writes originals and any resulting mutations | pass |
| TC-215 | FR-20 | Given rescan, then run writes refreshed documents instead of staying plan-only | pass |
| TC-216 | FR-20 | Given an unchanged second scan, then markdown sources are skipped and no original docs are rewritten | pass |
| TC-217 | FR-20 | Given one changed markdown source on rescan, then only that original doc is re-imported | pass |
| TC-218 | FR-20 | Given unchanged scan plan, then it does not emit preview diff chatter or synthetic scan files | pass |
| TC-219 | FR-20 | Given interactive rescan, then read-inputs does not ask initial interview questions or prompt to proceed | pass |
| TC-220 | FR-20 | Given interactive rescan through import-docs, then follow-up interview questions are skipped without a proceed prompt | pass |
| TC-221 | FR-20 | Given rescan with an active base, uses it in non-interactive mode | pass |
| TC-222 | FR-20 | Given rescan without --base and no selected base in non-interactive mode, throws guidance | pass |
| TC-223 | FR-20 | Given a full init cycle, then progress counter shows 3/3 (not more) | pass |
| TC-224 | FR-20 | Given a TypeScript-only project, then AST code-index uses no LLM tokens | pass |
| TC-225 | FR-20 | Given an active base, uses it without prompting | pass |
| TC-227 | FR-20 | Given --base flag, uses it directly without prompting | pass |
| TC-228 | FR-20 | Given no selected base and a single initialized base, auto-selects it without prompting | pass |
| TC-229 | FR-20 | Given no selected base and multiple bases, prompts with a list and accepts a typed name | pass |
| TC-230 | FR-20 | Given no selected base and multiple bases, passing suggestions list to askQuestion | pass |
| TC-231 | FR-20 | Given no selected base and multiple bases, an invalid name throws an error | pass |
| TC-232 | FR-20 | Given no selected base and /cancel answer, throws InitCancelledError | pass |
| TC-233 | FR-20 | Given no selected base and no initialized bases, throws a helpful error | pass |
| TC-234 | FR-20 | Given no selected base and --non-interactive, throws without prompting | pass |
| TC-236 | FR-20 | Given interactive init with a git URL entered first, then clones from that URL | pass |
| TC-237 | FR-20 | Given --git flag (non-interactive), then clones the repo onto the base volume | pass |
| TC-238 | FR-20 | Given --git without branch, then clones the remote default branch | pass |
| TC-239 | FR-20 | Given multiple --git targets, then both repos index into one base and the volume lists both | pass |
| TC-240 | FR-20 | Given /cancel at git URL prompt, throws InitCancelledError | pass |
| TC-241 | FR-20 | Given non-interactive init without --git, throws requiring a git remote | pass |
| TC-242 | FR-20 | Given interactive init with empty git answer then /cancel, throws InitCancelledError | pass |
| TC-243 | FR-20 | parseInitCommand parses --git and --branch flags | pass |
| TC-244 | FR-20 | parseInitCommand parses repeatable --git with inline branch (no branch = remote default) | pass |
| TC-245 | FR-20 | parseInitCommand with only --git leaves the branch undefined (remote default) | pass |
| TC-246 | FR-21 | returns null diff when no manifest exists yet (first run) | pass |
| TC-247 | FR-21 | round-trips manifest writes and detects changed/new source files only | pass |
| TC-248 | FR-21 | detects source files removed since the last manifest | pass |
| TC-249 | FR-21 | treats unchanged contents as a no-op diff | pass |
| TC-250 | FR-22 | Given many autogen-only docs and several source files, then append adds frozen originals per file | pass |
| TC-251 | FR-22 | Given an original shard already exists for a file title, then append does not duplicate that file | pass |
| TC-252 | FR-22 | Given README path, then isInitReadmeHomePath is true only for readme.md basename | pass |
| TC-253 | FR-22 | Given oversized file body, then snapshot content is clipped with truncation marker | pass |
| TC-254 | FR-23 | Given grounded source, user answers, and draft docs, then marks topic sufficient | pass |
| TC-255 | FR-23 | Given contradictory deployment signals, then surfaces unresolved contradiction gap | pass |
| TC-256 | FR-23 | Given weak non-interactive evidence, then marks topic inferred and summarizes unresolved topics | pass |
| TC-257 | FR-24 | parses query flags and query session support | pass |
| TC-258 | FR-24 | rejects unknown public commands | pass |
| TC-259 | FR-24 | only treats query as an intent command | pass |
| TC-260 | FR-24 | formats read_facts results in human mode | pass |
| TC-261 | FR-24 | prints minimal intent help with only the supported commands | pass |
| TC-262 | FR-24 | renders orchestration footer through printer helpers | pass |
| TC-263 | FR-24 | prints non-read_facts results without treating them as query results | pass |
| TC-264 | FR-24 | derives query evidence from retrieval checkpoints instead of a fixed router default | pass |
| TC-265 | FR-24 | keeps query rewrite/session fallback scoped to query only | pass |
| TC-266 | FR-24 | enriches query answers with the LLM | pass |
| TC-267 | FR-24 | replaces insufficient LLM answer with deterministic fallback from documents | pass |
| TC-268 | FR-24 | keeps long sufficient LLM answer unchanged | pass |
| TC-269 | FR-24 | forces build/config scaffold when answer lacks required sections | pass |
| TC-270 | FR-24 | keeps LLM answer when synthesisQuestion is pre-expansion text (not graph-expanded query) | pass |
| TC-271 | FR-24 | query synthesis allows a larger answer output budget | pass |
| TC-272 | FR-25 | returns default features when no env is set | pass |
| TC-273 | FR-25 | migrates legacy config.json base fields into line files | pass |
| TC-274 | FR-25 | reads server profile from KB_HOST/KB_PORT env | pass |
| TC-275 | FR-25 | returns config with default features enabled | pass |
| TC-276 | FR-25 | matches readKbConfig output | pass |
| TC-277 | FR-25 | returns fresh config with defaults | pass |
| TC-279 | FR-25 | returns false when no LLM env vars are set | pass |
| TC-280 | FR-25 | returns true when ANTHROPIC_API_KEY is set | pass |
| TC-281 | FR-25 | throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set | pass |
| TC-282 | FR-25 | does not throw for ollama (no key required) | pass |
| TC-283 | FR-25 | prefers env var when provider is declared | pass |
| TC-284 | FR-25 | auto-detects provider from env vars when no provider is declared | pass |
| TC-285 | FR-25 | falls back to ollama when nothing is configured | pass |
| TC-286 | FR-25 | supported config paths omit base-selection keys | pass |
| TC-287 | FR-25 | resolveFactRetrievalMethod defaults to query_expansion | pass |
| TC-288 | FR-25 | KB_FACT_RETRIEVAL_METHOD env override wins | pass |
| TC-289 | FR-25 | gemini model override preserved in provider resolution | pass |
| TC-290 | FR-25 | returns inferred provider notice when llm.provider is unset and env key exists | pass |
| TC-291 | FR-25 | does not infer when KB_LLM_PROVIDER is already set | pass |
| TC-292 | FR-25 | KB_LLM_PROVIDER env wins over auto-detect | pass |
| TC-293 | FR-25 | preserves createdAt on round-trip | pass |
| TC-294 | FR-25 | normalizes in memory without writing files | pass |
| TC-295 | FR-26 | splits on commas and newlines and trims | pass |
| TC-296 | FR-26 | drops empties | pass |
| TC-297 | FR-26 | trims, removes blanks, and de-duplicates preserving order | pass |
| TC-298 | FR-26 | matches bare names by basename at any depth | pass |
| TC-299 | FR-26 | anchors patterns that contain a slash | pass |
| TC-300 | FR-26 | honours a leading slash anchor | pass |
| TC-301 | FR-26 | trailing slash matches directories only (but still ignores their contents) | pass |
| TC-302 | FR-26 | supports * within a segment and ** across segments | pass |
| TC-303 | FR-26 | supports negation to re-include | pass |
| TC-304 | FR-26 | skips comments and blank lines | pass |
| TC-305 | FR-26 | an empty matcher ignores nothing | pass |
| TC-306 | FR-26 | normalizes backslashes and leading ./ in the tested path | pass |
| TC-307 | FR-26 | parses KB_SERVER_IGNORE (comma/newline separated) into patterns | pass |
| TC-308 | FR-26 | returns [] when KB_SERVER_IGNORE is unset or empty | pass |
| TC-309 | FR-27 | includes all three subcommands | pass |
| TC-310 | FR-27 | documents --since flag | pass |
| TC-311 | FR-27 | documents --base flag | pass |
| TC-312 | FR-27 | Given no reports, then returns empty message | pass |
| TC-313 | FR-27 | Given reports, then list includes run ID, command, and duration | pass |
| TC-314 | FR-27 | Given --command filter, then only matching command appears | pass |
| TC-315 | FR-27 | Given --limit 1, then only one row appears | pass |
| TC-316 | FR-27 | Given a known runId, then displays stage table | pass |
| TC-317 | FR-27 | Given a prefix of runId, then matches by prefix | pass |
| TC-318 | FR-27 | Given unknown runId, then throws not found error | pass |
| TC-319 | FR-27 | Given show with no runId, then throws usage error | pass |
| TC-320 | FR-27 | Given two init runs, then compare output contains stage names and deltas | pass |
| TC-321 | FR-27 | Given compare with --command init, then uses only init runs | pass |
| TC-322 | FR-27 | Given explicit runIds, then compares those two runs | pass |
| TC-323 | FR-27 | Given fewer than 2 runs, then throws with helpful message | pass |
| TC-324 | FR-27 | Given two runs with different stage sets, then union of stages appears in output | pass |
| TC-325 | FR-27 | Given compare output totals row, then Δms matches difference between runs | pass |
| TC-326 | FR-27 | Given --base filter, then only reports matching that base appear | pass |
| TC-327 | FR-27 | Given --base filter that matches nothing, then returns empty message | pass |
| TC-328 | FR-27 | Given --base combined with --command, then both filters apply | pass |
| TC-329 | FR-27 | Given --base filter, then compare uses only runs from that base | pass |
| TC-330 | FR-27 | Given no subcommand, then returns help text | pass |
| TC-331 | FR-27 | Given --help, then returns help text | pass |
| TC-332 | FR-27 | Given unknown subcommand, then throws with the subcommand name | pass |
| TC-350 | FR-30 | Given more than TOP_SOURCE_PREVIEW_LIMIT cited files, then footer says top N of M file(s) | pass |
| TC-351 | FR-30 | Given at most TOP_SOURCE_PREVIEW_LIMIT files, then footer says all M file(s), folding symbols | pass |
| TC-352 | FR-30 | Given no openable hits (incl. dropped fact:// refs), then footer is (none) | pass |
| TC-353 | FR-31 | Given no existing skill files, then installs all agents and returns installed actions | pass |
| TC-354 | FR-31 | Given already-installed skill with matching hash, then action is skipped | pass |
| TC-355 | FR-31 | Given stale skill hash, then action is updated | pass |
| TC-356 | FR-31 | Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb | pass |
| TC-357 | FR-31 | Given ~/.claude/CLAUDE.md already has KB section, then action is already-present | pass |
| TC-358 | FR-31 | Given ~/.codex/AGENTS.md exists without KB section, then injects blurb | pass |
| TC-359 | FR-31 | Given neither profile MD exists, then creates ~/.claude/CLAUDE.md | pass |
| TC-360 | FR-31 | Given both profile MDs exist, then only injects into whichever lacks the section | pass |
| TC-361 | FR-31 | shows installed skill files and injected profile entries | pass |
| TC-362 | FR-31 | shows skipped skill files as up-to-date | pass |
| TC-363 | FR-31 | Given installed skill files, then removes them and reports removed | pass |
| TC-364 | FR-31 | Given no skill files, then action is not-found | pass |
| TC-365 | FR-31 | Given profile MD with injected section, then removes the section | pass |
| TC-366 | FR-31 | Given profile MD without KB section, then action is not-found | pass |
| TC-367 | FR-31 | Given removed results, then formats readable output | pass |
| TC-368 | FR-31 | Given no provider config dirs, then Claude and antigravity-cli are still installed (ensureConfigDir) and others are not-installed | pass |
| TC-369 | FR-31 | Given Claude config dir exists with no settings.json, then creates settings.json with hook | pass |
| TC-370 | FR-31 | Given hook already installed at current path, then action is skipped | pass |
| TC-371 | FR-31 | Given hook installed at stale path, then updates to current path | pass |
| TC-372 | FR-31 | Given settings.json with existing hooks, then merges without clobbering | pass |
| TC-373 | FR-31 | Given Gemini config dir exists, then installs BeforeTool hook in settings.json | pass |
| TC-374 | FR-31 | Given Codex config dir exists, then installs hook in hooks.json | pass |
| TC-375 | FR-31 | Writes executable hook script that emits Claude JSON additionalContext | pass |
| TC-376 | FR-31 | Given Grep tool input, hook emits additionalContext JSON | pass |
| TC-377 | FR-31 | Given Read tool, hook stays silent | pass |
| TC-378 | FR-31 | Given hook present in settings.json, then removes it | pass |
| TC-379 | FR-31 | Given no settings.json, then action is not-installed | pass |
| TC-380 | FR-31 | Given settings.json without KB hook, then action is not-installed | pass |
| TC-381 | FR-31 | Given hook plus other hooks in same matcher group, then only removes kb hook | pass |
| TC-382 | FR-31 | includes Agent hooks section when hook results provided | pass |
| TC-383 | FR-31 | omits Agent hooks section when hook results not provided | pass |
| TC-384 | FR-31 | includes MCP sync section when mcp results provided | pass |
| TC-385 | FR-31 | includes MCP removals when mcp results provided | pass |
| TC-386 | FR-32 | greets the user | pass |
| TC-387 | FR-32 | lists the core commands | pass |
| TC-388 | FR-32 | tells the user how to get help | pass |
| TC-389 | FR-32 | is a non-empty string | pass |
| TC-390 | FR-32 | names the base in the notice | pass |
| TC-391 | FR-32 | points the user to server-managed indexing (KB_GIT_REPOS) | pass |
| TC-392 | FR-32 | suggests switching base via kb base use | pass |
| TC-393 | FR-32 | reflects the given base name exactly | pass |
| TC-394 | FR-33 | Given --help, then prints release-based sync help | pass |
| TC-395 | FR-33 | Given no flags, then sync downloads and extracts both release runtimes and links stable client/server binaries | pass |
| TC-396 | FR-33 | Given legacy no-build flag, then sync rejects it | pass |
| TC-397 | FR-33 | Given positional args, then sync rejects them | pass |
| TC-398 | FR-34 | client uninstall removes kb only and preserves kb-server + server data | pass |
| TC-399 | FR-34 | removes PATH entries from rc files only when both binaries are gone | pass |
| TC-400 | FR-34 | kb uninstall rejects --purge with kb-server guidance | pass |
| TC-401 | FR-34 | --yes removes client without prompting | pass |
| TC-402 | FR-34 | kb-server uninstall without purge keeps ~/.kb server data | pass |
| TC-403 | FR-34 | kb-server uninstall --purge removes server data but keeps kb client install | pass |
| TC-404 | FR-34 | kb-server uninstall --purge --yes deletes server data | pass |
| TC-419 | FR-31 | Given non-search Bash commands, hook stays silent | pass |
| TC-420 | FR-31 | Given grep only filtering another command output, hook stays silent | pass |
| TC-421 | FR-31 | Given repo-search commands in command position, hook fires | pass |
| TC-422 | FR-31 | Given a repeat search in the same session window, hook reminds only once | pass |
| TC-423 | FR-31 | Given KB_HOOK_REMINDER=false, hook stays silent even for searches | pass |
| TC-424 | FR-37 | Given two repos with a colliding repo-relative AST key, then per-slug manifests do not clobber each other and each repo sees its own hashes as unchanged | pass |
| TC-425 | FR-37 | Given an undefined slug, then the AST manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-426 | FR-38 | Given a prior AST manifest, then diffRemovedAstFiles reports only paths dropped from the current tree | pass |
| TC-427 | FR-37 | Given two repos with a colliding repo-relative source key, then per-slug source manifests do not clobber each other and each repo sees its own content as unchanged | pass |
| TC-428 | FR-37 | Given an undefined slug, then the source manifest uses the un-suffixed legacy filename and a slug read does not fall back to it | pass |
| TC-429 | FR-37 | Given a warm rescan of an unchanged multi-repo base, then each repo detects 0 changed and no facts are lost | pass |
| TC-430 | FR-38 | Given a changed or deleted file in one repo, then only that repo is reindexed and unchanged files' and sibling repos' facts survive | pass |
| TC-431 | FR-39 | Given kb skills install, then registers kb-feedback.sh for Claude PostToolUse, PreToolUse, and Stop | pass |
| TC-432 | FR-39 | Given a query PostToolUse event, then records the used marker and stays silent | pass |
| TC-433 | FR-39 | Given git push after query use, then injects a submit_feedback reminder pointing at get_feedback_requests | pass |
| TC-434 | FR-39 | Given Stop after query use without feedback, then blocks once with a submit_feedback reason | pass |
| TC-435 | FR-39 | Given submit_feedback already called or a prior nudge, then push reminder and Stop stay silent | pass |
| TC-436 | FR-39 | Given no query use or KB_FEEDBACK_REMINDER=false, then all feedback events stay silent | pass |
| TC-437 | FR-39 | Given installed feedback hooks, then uninstall removes them from all three Claude events | pass |
| TC-438 | FR-40 | provider throws during synthesis | answerError records kind and stage; results and status preserved |
| TC-439 | FR-40 | model returns only whitespace | answerError kind is empty_response |
| TC-440 | FR-40 | synthesis succeeds | answer set and no answerError attached |
| TC-441 | FR-40 | curator fell back without judging | no note claims the evidence was focused |
| TC-442 | FR-41 | no run reports with a sessionId | returns a friendly "no chat sessions yet" notice |
| TC-443 | FR-41 | reports across two sessions | summarizes the most recent session's runs and token totals |
| TC-444 | FR-41 | --session prefix selector | selects that session even when it is not the most recent |
| TC-445 | FR-41 | unknown --session selector | throws a "Session not found" error |
| TC-446 | FR-42 | no skill files present | status report says no agent skills are installed |
| TC-447 | FR-42 | a skill file present with a stale hash | status report flags that agent as update-available |
| TC-448 | FR-41 | session reports carry transcript turns | renders the concatenated conversation transcript |
| TC-449 | FR-27 | logs list with no --command | per-turn chat reports are hidden from the listing |
| TC-450 | FR-27 | logs list --command chat | chat reports are shown |
| TC-451 | FR-27 | logs show on a chat run with turns | renders the turn transcript |

### Related docs

- [CLI.md](CLI.md)
- [TUI.md](../core/TUI.md)
