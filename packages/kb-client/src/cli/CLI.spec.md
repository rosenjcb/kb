---
type: Spec
title: "Spec: CLI Layer"
sources: ./
tests: ../../../../tests/cli
description: Behavioral specification for CLI Layer
tags: [spec, kb]
timestamp: 2026-06-28T04:05:29Z
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
|------|------------|
| FR-1 | Auto-sync polls remotes and triggers incremental reindex when commits change |
| FR-2 | Global CLI routing parses flags, defaults, and dispatches subcommands |
| FR-3 | Base metadata commands expose active base name and selection state |
| FR-4 | Base selection resolves `--base`, config default, and manifest precedence |
| FR-5 | Chat REPL parses turns, streams output, and manages session lifecycle |
| FR-6 | Chat document-generation flow wires doc tools into chat turns |
| FR-7 | Chat query orchestrator delegates QUERY turns to shared retrieval |
| FR-8 | Chat retrieval refusal surfaces when evidence is insufficient |
| FR-9 | Command reference generation stays in sync with registered commands |
| FR-10 | Init collects source files from configured git targets |
| FR-12 | Docs delete CLI removes documents with confirmation and index cleanup |
| FR-13 | Docs generate CLI drives the document-generation pipeline |
| FR-14 | Docs generate flow integrates questionnaire → draft → write |
| FR-15 | Docs generate sections splits and merges generated section files |
| FR-16 | Docs rename CLI renames documents and updates references |
| FR-17 | Facts CLI parses list/read subcommands and retrieval flags |
| FR-18 | Git sync pulls tracked repos and reports sync status |
| FR-19 | Graph CLI exposes code-graph query and summary subcommands |
| FR-20 | Init AST files manifest records parsed symbol files per cycle |
| FR-21 | Init pipeline runs multi-cycle scan, enrichment, and synthesis |
| FR-22 | Init source files manifest tracks cloned repo paths and branches |
| FR-23 | Init source snapshots capture per-cycle file hashes for drift detection |
| FR-24 | Init topic coverage reports document-type coverage gaps |
| FR-25 | Intent CLI parses query envelopes and routes to retrieval |
| FR-26 | KB config loader merges defaults, file config, and env overrides |
| FR-27 | kb.ignore patterns exclude paths from indexing |
| FR-29 | Logs CLI reads structured run reports from the logs directory |
| FR-30 | Named-list interview parses numbered selections in TTY prompts |
| FR-31 | Publish CLI pushes companion docs to configured publish targets |
| FR-32 | Repo CLI manages tracked git remotes on a base |
| FR-33 | Retrieval fallback degrades gracefully when deep retrieval fails |
| FR-34 | Skill installer copies bundled skills to agent home directories |
| FR-35 | Startup notices print one-time migration and version hints |
| FR-36 | Sync CLI triggers manual pull + reindex across tracked repos |
| FR-37 | Client uninstall removes release client layout; server uninstall removes server layout and optional ~/.kb data |
| FR-38 | View CLI renders documents and facts for terminal inspection |
| FR-39 | Connection context (host + base) is printed on CLI banner, TUI status bar, and chat session open |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given no meta.json, then no-ops | pass |
| TC-2 | FR-1 | Given a repo synced within the stale window, then skips pull | pass |
| TC-3 | FR-1 | Given a stale repo with no new commits, then refreshes lastSyncedAt without rescanning | pass |
| TC-4 | FR-1 | Given a stale repo with new commits, then pulls and re-indexes that repo by slug | pass |
| TC-5 | FR-1 | Given multiple repos, then only the changed repo is re-indexed and others keep their sha | pass |
| TC-6 | FR-1 | Given one repo's pull fails, then the other repos still sync | pass |
| TC-7 | FR-1 | Given staleLimitMs: 0, then pulls even a freshly-synced repo | pass |
| TC-8 | FR-2 | Given kb base use <base>, then sets activeBase and prints resolved path | pass |
| TC-9 | FR-2 | Given kb base use --default <base>, then sets both defaultBase and activeBase | pass |
| TC-10 | FR-2 | Given kb base use <base> that does not exist, then errors with server-managed guidance | pass |
| TC-11 | FR-2 | Given kb base use --show, then prints current base config | pass |
| TC-12 | FR-2 | Given kb base --help, then prints base help | pass |
| TC-13 | FR-2 | Given --force, then deletes the session directory | pass |
| TC-14 | FR-2 | Given --force and base is activeBase, then clears it from config | pass |
| TC-15 | FR-2 | Given --force and base is defaultBase, then clears it from config | pass |
| TC-16 | FR-2 | Given no --force in TUI mode, then does NOT hang — returns prompt to use --force | pass |
| TC-17 | FR-2 | Given no --force in CLI mode with non-TTY stdin, then aborts without deleting | pass |
| TC-18 | FR-2 | Given no base name, then prints help | pass |
| TC-19 | FR-2 | Given --help, then prints delete help | pass |
| TC-20 | FR-2 | Given no bases, then reports no bases on server | pass |
| TC-21 | FR-2 | Given initialized bases, then lists them | pass |
| TC-22 | FR-2 | Marks the active and default bases with tags | pass |
| TC-23 | FR-2 | kb base list produces the same output as kb base | pass |
| TC-24 | FR-2 | Shows .kb file info when present in cwd | pass |
| TC-26 | FR-2 | Given kb --help, then prints --host and core commands | pass |
| TC-28 | FR-3 | readBaseMeta returns null when meta.json does not exist | pass |
| TC-29 | FR-3 | round-trips a multi-repo meta | pass |
| TC-30 | FR-3 | normalizes a legacy single-repo meta into one repo entry keeping the repo/ clone dir | pass |
| TC-31 | FR-3 | round-trips an ignore list alongside repos | pass |
| TC-32 | FR-3 | repoSlugFromGitUrl handles https, ssh, and local paths | pass |
| TC-33 | FR-3 | repoDirForSlug nests clones under repos/ | pass |
| TC-34 | FR-4 | alias base resolves to namespaced sessions directory | pass |
| TC-35 | FR-4 | path-like base resolves relative to cwd | pass |
| TC-36 | FR-4 | absolute path base is returned as-is | pass |
| TC-37 | FR-4 | active base in config wins over defaultBase | pass |
| TC-38 | FR-4 | config.defaultBase is used when KB_BASE is not set | pass |
| TC-39 | FR-4 | throws when neither activeBase nor config.defaultBase is set | pass |
| TC-40 | FR-4 | writeDefaultBase persists to config and readBaseConfig reads it back | pass |
| TC-41 | FR-4 | writeDefaultBase overwrites a prior default | pass |
| TC-42 | FR-4 | writeSessionBase persists the active base separately from the default | pass |
| TC-43 | FR-4 | migrates legacy session.json into state files and removes session.json | pass |
| TC-44 | FR-4 | ensureOperationalBaseDir migrates legacy repo sqlite into KB home | pass |
| TC-45 | FR-4 | ensureOperationalBaseDir migrates legacy KB home base directory into sessions namespace | pass |
| TC-46 | FR-4 | formatUseCommandHelp shows active session switching | pass |
| TC-47 | FR-4 | formatDefaultCommandHelp shows persistent default messaging | pass |
| TC-48 | FR-4 | formatUseCommandHelp uses slash hints in TUI mode | pass |
| TC-49 | FR-4 | formatDefaultCommandHelp uses slash hints in TUI mode | pass |
| TC-50 | FR-4 | Given an existing named base, then deletes its session directory | pass |
| TC-51 | FR-4 | Given legacy + tmp checkpoint artifacts, then purges them too | pass |
| TC-52 | FR-4 | Given the base is the active base, then clears it from config | pass |
| TC-53 | FR-4 | Given the base is the selected (default) base, then clears it from config | pass |
| TC-54 | FR-4 | Given the base does not exist on disk, then succeeds without error | pass |
| TC-55 | FR-4 | Given a path-like base, then throws rather than deleting arbitrary paths | pass |
| TC-56 | FR-4 | includes base delete usage in CLI mode | pass |
| TC-57 | FR-4 | includes base delete usage in TUI mode | pass |
| TC-58 | FR-4 | includes the base name and path in output | pass |
| TC-59 | FR-4 | mentions cleared active base when applicable | pass |
| TC-60 | FR-4 | mentions cleared default base when applicable | pass |
| TC-61 | FR-4 | returns the base name from a .kb file in the given directory | pass |
| TC-62 | FR-4 | finds a .kb file in an ancestor directory | pass |
| TC-63 | FR-4 | returns null when no .kb file exists in any ancestor | pass |
| TC-64 | FR-4 | trims whitespace from the base name | pass |
| TC-65 | FR-4 | returns null when .kb file is empty | pass |
| TC-66 | FR-4 | writes a .kb file containing the base name | pass |
| TC-67 | FR-4 | overwrites an existing .kb file | pass |
| TC-68 | FR-4 | returns empty array when sessions directory does not exist | pass |
| TC-69 | FR-4 | returns only directories that contain .kb-index.sqlite | pass |
| TC-70 | FR-4 | marks the active and default bases correctly | pass |
| TC-71 | FR-4 | returns bases sorted alphabetically | pass |
| TC-72 | FR-4 | uses .kb file when no activeBase or defaultBase is configured | pass |
| TC-73 | FR-4 | .kb file takes priority over config.activeBase | pass |
| TC-74 | FR-4 | falls back to config.activeBase when no .kb file is found | pass |
| TC-75 | FR-4 | falls back to config.defaultBase when no .kb file and no activeBase | pass |
| TC-76 | FR-4 | finds .kb file from a subdirectory via ancestor walk | pass |
| TC-77 | FR-4 | readOptionalCliValue returns the following token | pass |
| TC-78 | FR-4 | readOptionalCliValue returns undefined when flag or value is missing | pass |
| TC-79 | FR-4 | stripCliFlagWithValue removes --base and its value | pass |
| TC-80 | FR-4 | resolveKbStorageDirFromArgs honors --base over active session | pass |
| TC-81 | FR-4 | resolveKbStorageDirFromArgs falls back to effective base when --base omitted | pass |
| TC-82 | FR-5 | Given chat help printer, then returns grouped usage and interactive commands including /clear | pass |
| TC-83 | FR-5 | Given evidence and question, then turn content includes evidence block and question without embedded history | pass |
| TC-84 | FR-5 | Given long retrieved fact bodies, then turn content truncates each fact for synthesis | pass |
| TC-85 | FR-5 | Given /help and /exit, then prints commands and exits without tool calls | pass |
| TC-86 | FR-5 | Given /clear, then prints fresh session message and subsequent turn uses empty message history | pass |
| TC-88 | FR-5 | Given a simple greeting, then LLM answers directly without calling executor | pass |
| TC-89 | FR-5 | Given a KB question, then LLM calls query_kb, retrieval runs, and LLM synthesizes the answer | pass |
| TC-90 | FR-5 | Given provider failure, then loop reports error and remains interactive | pass |
| TC-91 | FR-5 | Given a KB question, then retrieval always uses deep discovery policy | pass |
| TC-92 | FR-5 | Given a KB question, then retrieval call has correct read_facts shape | pass |
| TC-93 | FR-5 | Given a two-turn session, then second LLM call includes first-turn context in message history | pass |
| TC-94 | FR-5 | Given a process question, then query_kb tool is called and answer is surfaced | pass |
| TC-95 | FR-5 | Given an unknown runtime question, then query_kb retrieves runbook and surfaces the answer | pass |
| TC-96 | FR-5 | Given user message that is just a follow-up phrase, then LLM can answer directly without retrieval | pass |
| TC-97 | FR-5 | Given fact upsert and invalidate changes in the same base, then conversational chat reflects updated facts across turns | pass |
| TC-98 | FR-5 | Given a multi-round query where LLM calls query_kb twice across rounds, then both retrievals run and final answer is returned | pass |
| TC-99 | FR-5 | Given a turn where LLM returns two tool calls in one round, then both execute and results are returned | pass |
| TC-100 | FR-5 | Given a synthesis keyword query, then decompose pre-step fires and sub-queries are logged before main loop | pass |
| TC-101 | FR-5 | Given a short or non-synthesis query, then decompose pre-step is skipped | pass |
| TC-102 | FR-5 | Given retrieval provided, then synthesizes answer from pre-fetched context without extra retrieval | pass |
| TC-103 | FR-5 | Given multi-round loop, then calls query_kb in parallel and populates lastIntentResult | pass |
| TC-104 | FR-5 | Given retrieval undefined (chat path), then starts loop from provided messages directly | pass |
| TC-105 | FR-6 | Given slash line with prompt, answers questionnaire and accept writes document | pass |
| TC-106 | FR-7 | Given a mocked read_facts result, then returns accepted read_facts IntentResult | pass |
| TC-107 | FR-8 | refuses when no results | pass |
| TC-108 | FR-8 | allows when retrieval detail is all-facts:already-in-context even with zero results | pass |
| TC-109 | FR-8 | refuses when last checkpoint below default min | pass |
| TC-110 | FR-8 | allows when checkpoints missing (no signal) | pass |
| TC-111 | FR-8 | allows when last checkpoint at or above min | pass |
| TC-112 | FR-8 | respects KB_CHAT_RETRIEVAL_MIN_CONFIDENCE | pass |
| TC-113 | FR-8 | formats user/assistant pairs and tail-truncates | pass |
| TC-114 | FR-9 | returns /name in tui mode | pass |
| TC-115 | FR-9 | returns kb name in cli mode | pass |
| TC-116 | FR-9 | defaults to cli mode | pass |
| TC-117 | FR-9 | handles multi-word names in tui mode | pass |
| TC-118 | FR-9 | handles multi-word names in cli mode | pass |
| TC-119 | FR-9 | handles names with flags in tui mode | pass |
| TC-120 | FR-9 | returns TUI-style intro in tui mode | pass |
| TC-121 | FR-9 | returns CLI-style intro in cli mode | pass |
| TC-122 | FR-9 | shows /command syntax in tui mode | pass |
| TC-123 | FR-9 | shows kb command syntax in cli mode | pass |
| TC-124 | FR-9 | accepts valid modes without type error | pass |
| TC-125 | FR-10 | walks deeply nested directories without stopping early | pass |
| TC-126 | FR-10 | collects more than 100 markdown files (no file-count cap) | pass |
| TC-127 | FR-10 | skips dotfile directories | pass |
| TC-128 | FR-10 | skips excluded directories like node_modules | pass |
| TC-129 | FR-10 | explores sibling directories at the same depth | pass |
| TC-130 | FR-10 | respects an ignore matcher (prunes dirs and files) | pass |
| TC-152 | FR-12 | Given a doc id, then parses it | pass |
| TC-153 | FR-12 | Given --force flag, then sets force true | pass |
| TC-154 | FR-12 | Given -f shorthand, then sets force true | pass |
| TC-155 | FR-12 | Given --base flag, then captures base | pass |
| TC-156 | FR-12 | Given id with caps/spaces, then normalizes to slug | pass |
| TC-157 | FR-12 | Given a wildcard pattern, then sets isWildcard true and preserves * | pass |
| TC-158 | FR-12 | Given a wildcard pattern with caps, then lowercases and preserves * | pass |
| TC-159 | FR-12 | Given a bare wildcard *, then isWildcard is true | pass |
| TC-160 | FR-12 | Given no args, then throws with exit code 0 | pass |
| TC-161 | FR-12 | Given --help, then throws with exit code 0 | pass |
| TC-162 | FR-12 | Given two positional args, then throws | pass |
| TC-163 | FR-12 | Given unknown flag, then throws | pass |
| TC-164 | FR-12 | Given --base with no value, then throws | pass |
| TC-165 | FR-12 | Given --force and existing doc, then removes the document | pass |
| TC-166 | FR-12 | Given --force, then output confirms deletion with title and id | pass |
| TC-167 | FR-12 | Given --force, then other documents are unaffected | pass |
| TC-168 | FR-12 | Given non-existent doc id, then throws DocsDeleteError | pass |
| TC-169 | FR-12 | Given non-interactive stdin and no --force, then aborts without deleting | pass |
| TC-170 | FR-12 | Given a prefix wildcard, then deletes all matching documents | pass |
| TC-171 | FR-12 | Given a wildcard match, then output lists matched ids and confirms each deletion | pass |
| TC-172 | FR-12 | Given a wildcard with no matches, then throws DocsDeleteError | pass |
| TC-173 | FR-12 | Given wildcard and non-interactive stdin without --force, then aborts without deleting | pass |
| TC-174 | FR-13 | Given help flag, then throws exit 0 | pass |
| TC-175 | FR-13 | Given start prompt and --type, then parses | pass |
| TC-176 | FR-13 | Given --resume and --answer, then parses | pass |
| TC-177 | FR-13 | Given --resume and --accept, then parses | pass |
| TC-178 | FR-13 | Given --resume and --reject, then parses feedback | pass |
| TC-179 | FR-13 | Given --finalize and --accept with resume, then throws mutual exclusion | pass |
| TC-180 | FR-13 | Given --resume without action, then throws | pass |
| TC-181 | FR-13 | Given --list, then parses | pass |
| TC-182 | FR-13 | Given --show id, then parses | pass |
| TC-183 | FR-13 | Given multiple positional tokens, then joins into prompt | pass |
| TC-184 | FR-13 | Given --output json, then parses outputFormat | pass |
| TC-185 | FR-13 | isDocsGenerateJsonOutputArgs detects docs generate --output json | pass |
| TC-186 | FR-14 | Given full questionnaire answered, finalize writes document with doc type | pass |
| TC-187 | FR-15 | Given /skip, then returns skip without asking for descriptions | pass |
| TC-188 | FR-15 | Given blank input, then returns skip | pass |
| TC-189 | FR-15 | Given /cancel on name prompt, then returns cancel | pass |
| TC-190 | FR-15 | Given null read on name prompt, then returns cancel | pass |
| TC-191 | FR-15 | Given name then /cancel on description, then returns cancel | pass |
| TC-192 | FR-15 | Given multiple sections one at a time, then returns sections after /complete | pass |
| TC-193 | FR-15 | Given sections with descriptions, then returns sections with user descriptions | pass |
| TC-194 | FR-15 | Given blank description for a section, then uses default | pass |
| TC-195 | FR-15 | Given /complete with no sections, then returns skip | pass |
| TC-196 | FR-15 | Given each added section, then writes running list to output | pass |
| TC-197 | FR-16 | Given doc id and new title, then parses both | pass |
| TC-198 | FR-16 | Given --base flag, then captures base | pass |
| TC-199 | FR-16 | Given doc id with caps/spaces, then normalizes to slug | pass |
| TC-200 | FR-16 | Given no args, then throws with exit code 0 | pass |
| TC-201 | FR-16 | Given --help, then throws with exit code 0 | pass |
| TC-202 | FR-16 | Given only one positional arg, then throws | pass |
| TC-203 | FR-16 | Given three positional args, then throws with wrapping hint | pass |
| TC-204 | FR-16 | Given empty string as new title, then throws | pass |
| TC-205 | FR-16 | Given unknown flag, then throws | pass |
| TC-206 | FR-16 | Given existing doc, then updates title in stored content | pass |
| TC-207 | FR-16 | Given existing doc, then doc id is unchanged | pass |
| TC-208 | FR-16 | Given existing doc, then body content is preserved | pass |
| TC-209 | FR-16 | Given existing doc with tags and type, then metadata is preserved | pass |
| TC-210 | FR-16 | Given existing doc, then output confirms old and new title | pass |
| TC-211 | FR-16 | Given non-existent doc id, then throws DocsRenameError | pass |
| TC-212 | FR-17 | Given list subcommand, then parses limit and base | pass |
| TC-213 | FR-17 | Given --help, then throws FactsCommandError exit 0 | pass |
| TC-214 | FR-17 | Given search without query, then throws | pass |
| TC-215 | FR-17 | Given seeded facts, list and search return human text | pass |
| TC-216 | FR-17 | Given fact id, show returns that row | pass |
| TC-217 | FR-18 | derives name from https URL with .git suffix | pass |
| TC-218 | FR-18 | derives name from https URL without .git suffix | pass |
| TC-219 | FR-18 | derives name from https URL with trailing slash | pass |
| TC-220 | FR-18 | derives name from ssh URL | pass |
| TC-221 | FR-18 | lowercases the result | pass |
| TC-222 | FR-18 | replaces special characters (but keeps underscore, dot, dash) with dashes | pass |
| TC-223 | FR-18 | Given no branch, then clones the remote default branch | pass |
| TC-224 | FR-18 | Given an explicit branch, then clones that branch | pass |
| TC-225 | FR-18 | disables interactive git prompts even without a token | pass |
| TC-226 | FR-18 | uses GITHUB_TOKEN when present | pass |
| TC-227 | FR-18 | falls back to GH_TOKEN when GITHUB_TOKEN is absent | pass |
| TC-228 | FR-18 | prefers GITHUB_TOKEN over GH_TOKEN when both are present | pass |
| TC-229 | FR-18 | Given a dirty .kb marker in the clone, then pull succeeds | pass |
| TC-230 | FR-18 | Given dirty tracked files and no new remote commits, then pull discards local edits | pass |
| TC-231 | FR-18 | Given dirty tracked files and new remote commits, then pull succeeds | pass |
| TC-232 | FR-18 | clones a repo whose default branch is master without specifying a branch | pass |
| TC-233 | FR-18 | honors an explicitly requested branch | pass |
| TC-234 | FR-19 | Given graph help flag, then parser returns graph-specific help text | pass |
| TC-235 | FR-19 | Given graph entity flag, then parser returns entity lookup options | pass |
| TC-236 | FR-19 | Given graph path flag, then parser returns path lookup options | pass |
| TC-237 | FR-19 | Given graph format flag, then parser returns export format option | pass |
| TC-238 | FR-19 | prints grouped graph usage and examples | pass |
| TC-239 | FR-19 | routes default summary output through the out parameter, not console.log | pass |
| TC-240 | FR-19 | routes --format dot output through the out parameter | pass |
| TC-241 | FR-19 | routes --format json output through the out parameter | pass |
| TC-242 | FR-19 | reports no-path-found through the out parameter | pass |
| TC-243 | FR-19 | reports entity-not-found through the out parameter | pass |
| TC-244 | FR-20 | returns null diff when no manifest exists yet (first run) | pass |
| TC-245 | FR-20 | round-trips manifest writes and detects changed/new files only | pass |
| TC-246 | FR-20 | treats unchanged contents as a no-op diff | pass |
| TC-247 | FR-21 | Given init without --base, then it prompts for a base name and uses the answer | pass |
| TC-248 | FR-21 | Given init without --base and config activeBase, then prompt suggests the first git remote slug | pass |
| TC-249 | FR-21 | Given detach and resume flags, then parses them into init options | pass |
| TC-250 | FR-21 | Given scan args, then parsing implies rescan and always applies automatically | pass |
| TC-251 | FR-21 | Given --stop-after document-facts, then parsing returns document-facts | pass |
| TC-252 | FR-21 | Given init cycle validation, then exactly 5 phases are defined without pass-graph | pass |
| TC-253 | FR-21 | Given a custom progress sink, then init progress updates route there instead of writing directly to stderr | pass |
| TC-254 | FR-21 | Given interactive init, then read-inputs does not ask deprecated interview questions | pass |
| TC-255 | FR-21 | Given resume after import-docs pause, then finishes init without re-asking read-inputs | pass |
| TC-256 | FR-21 | Given version 1 checkpoint, then resume migrates it to version 3 without reviving deprecated answers | pass |
| TC-257 | FR-21 | Given detach during read-inputs, then init no longer stores pending interview questions | pass |
| TC-258 | FR-21 | Given legacy tmp checkpoint path, then init migrates it into KB home checkpoints | pass |
| TC-259 | FR-21 | Given resume after read-inputs, then deprecated interview prompting does not resume | pass |
| TC-260 | FR-21 | Given several repo markdown files, then import-docs checkpoint lists each as original | pass |
| TC-261 | FR-21 | Given rescan, then read-inputs loads all markdown sources under cwd | pass |
| TC-262 | FR-21 | Given published snapshot docs, then read-inputs excludes published snapshots and export artifacts | pass |
| TC-263 | FR-21 | Given no markdown sources under the working directory, then document-facts stage is skipped | pass |
| TC-264 | FR-21 | Given multiple markdown sources, then iterable init phases emit current-item progress | pass |
| TC-265 | FR-21 | Given rescan, then write cycle writes originals and any resulting mutations | pass |
| TC-266 | FR-21 | Given rescan, then run writes refreshed documents instead of staying plan-only | pass |
| TC-267 | FR-21 | Given an unchanged second scan, then markdown sources are skipped and no original docs are rewritten | pass |
| TC-268 | FR-21 | Given one changed markdown source on rescan, then only that original doc is re-imported | pass |
| TC-269 | FR-21 | Given unchanged scan plan, then it does not emit preview diff chatter or synthetic scan files | pass |
| TC-270 | FR-21 | Given interactive rescan, then read-inputs does not ask initial interview questions or prompt to proceed | pass |
| TC-271 | FR-21 | Given interactive rescan through import-docs, then follow-up interview questions are skipped without a proceed prompt | pass |
| TC-272 | FR-21 | Given rescan with a .kb file in cwd, uses the pinned base even in non-interactive mode | pass |
| TC-273 | FR-21 | Given rescan without --base and no .kb file in non-interactive mode, throws with .kb guidance | pass |
| TC-274 | FR-21 | Given a full init cycle, then progress counter shows 6/6 (not 7) | pass |
| TC-275 | FR-21 | Given a TypeScript-only project, then AST code-index uses no LLM tokens | pass |
| TC-276 | FR-21 | Given a .kb file in cwd, uses that base without prompting | pass |
| TC-277 | FR-21 | Given a .kb file in an ancestor dir, uses that base without prompting | pass |
| TC-278 | FR-21 | Given --base flag, uses it directly without reading .kb file or prompting | pass |
| TC-279 | FR-21 | Given no .kb file and a single initialized base, auto-selects it without prompting | pass |
| TC-280 | FR-21 | Given no .kb file and multiple bases, prompts with a list and accepts a typed name | pass |
| TC-281 | FR-21 | Given no .kb file and multiple bases, passing suggestions list to askQuestion | pass |
| TC-282 | FR-21 | Given no .kb file and multiple bases, an invalid name throws an error | pass |
| TC-283 | FR-21 | Given no .kb file and /cancel answer, throws InitCancelledError | pass |
| TC-284 | FR-21 | Given no .kb file and no initialized bases, throws a helpful error | pass |
| TC-285 | FR-21 | Given no .kb file and --non-interactive, throws without prompting | pass |
| TC-286 | FR-21 | After rescan completes, leaves any existing .kb file in cwd unchanged | pass |
| TC-287 | FR-21 | Given interactive init with a git URL entered first, then clones from that URL | pass |
| TC-288 | FR-21 | Given --git flag (non-interactive), then clones and writes meta.json | pass |
| TC-289 | FR-21 | Given --git without branch, then clones the remote default branch | pass |
| TC-290 | FR-21 | Given multiple --git targets, then both repos index into one base and meta lists both | pass |
| TC-291 | FR-21 | Given /cancel at git URL prompt, throws InitCancelledError | pass |
| TC-291b | FR-21 | Given non-interactive init without --git, throws requiring a git remote | pass |
| TC-291c | FR-21 | Given interactive init with empty git answer then /cancel, throws InitCancelledError | pass |
| TC-292 | FR-21 | parseInitCommand parses --git and --branch flags | pass |
| TC-293 | FR-21 | parseInitCommand parses repeatable --git with inline branch (no branch = remote default) | pass |
| TC-294 | FR-21 | parseInitCommand with only --git leaves the branch undefined (remote default) | pass |
| TC-295 | FR-22 | returns null diff when no manifest exists yet (first run) | pass |
| TC-296 | FR-22 | round-trips manifest writes and detects changed/new source files only | pass |
| TC-297 | FR-22 | detects source files removed since the last manifest | pass |
| TC-298 | FR-22 | treats unchanged contents as a no-op diff | pass |
| TC-299 | FR-23 | Given many autogen-only docs and several source files, then append adds frozen originals per file | pass |
| TC-300 | FR-23 | Given an original shard already exists for a file title, then append does not duplicate that file | pass |
| TC-301 | FR-23 | Given README path, then isInitReadmeHomePath is true only for readme.md basename | pass |
| TC-302 | FR-23 | Given oversized file body, then snapshot content is clipped with truncation marker | pass |
| TC-303 | FR-24 | Given grounded source, user answers, and draft docs, then marks topic sufficient | pass |
| TC-304 | FR-24 | Given contradictory deployment signals, then surfaces unresolved contradiction gap | pass |
| TC-305 | FR-24 | Given weak non-interactive evidence, then marks topic inferred and summarizes unresolved topics | pass |
| TC-306 | FR-25 | parses query flags and query session support | pass |
| TC-307 | FR-25 | rejects unknown public commands | pass |
| TC-308 | FR-25 | only treats query as an intent command | pass |
| TC-309 | FR-25 | formats read_facts results in human mode | pass |
| TC-310 | FR-25 | prints minimal intent help with only the supported commands | pass |
| TC-311 | FR-25 | renders orchestration footer through printer helpers | pass |
| TC-312 | FR-25 | prints non-read_facts results without treating them as query results | pass |
| TC-313 | FR-25 | derives query confidence from retrieval checkpoints instead of a fixed router default | pass |
| TC-314 | FR-25 | keeps query rewrite/session fallback scoped to query only | pass |
| TC-315 | FR-25 | enriches query answers with the LLM | pass |
| TC-316 | FR-25 | replaces insufficient LLM answer with deterministic fallback from documents | pass |
| TC-317 | FR-25 | keeps long sufficient LLM answer unchanged | pass |
| TC-318 | FR-25 | forces build/config scaffold when answer lacks required sections | pass |
| TC-319 | FR-25 | keeps LLM answer when synthesisQuestion is pre-expansion text (not graph-expanded query) | pass |
| TC-320 | FR-25 | query synthesis allows a larger answer output budget | pass |
| TC-321 | FR-26 | returns default features when no env is set | pass |
| TC-322 | FR-26 | migrates legacy config.json base fields into line files | pass |
| TC-323 | FR-26 | reads server profile from KB_HOST/KB_PORT env | pass |
| TC-324 | FR-26 | returns config with default features enabled | pass |
| TC-325 | FR-26 | matches readKbConfig output | pass |
| TC-326 | FR-26 | returns fresh config with defaults | pass |
| TC-327 | FR-26 | picks up NOTION env vars | pass |
| TC-329 | FR-26 | returns false when no LLM env vars are set | pass |
| TC-330 | FR-26 | returns true when ANTHROPIC_API_KEY is set | pass |
| TC-333 | FR-26 | throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set | pass |
| TC-336 | FR-26 | does not throw for ollama (no key required) | pass |
| TC-340 | FR-26 | prefers env var when provider is declared | pass |
| TC-341 | FR-26 | auto-detects provider from env vars when no provider is declared | pass |
| TC-344 | FR-26 | falls back to ollama when nothing is configured | pass |
| TC-137 | FR-26 | supported config paths omit base-selection keys | pass |
| TC-141 | FR-26 | resolveFactRetrievalMethod defaults to query_expansion | pass |
| TC-143 | FR-26 | KB_FACT_RETRIEVAL_METHOD env override wins | pass |
| TC-147 | FR-26 | gemini model override preserved in provider resolution | pass |
| TC-345 | FR-26 | returns inferred provider notice when llm.provider is unset and env key exists | pass |
| TC-346 | FR-26 | does not persist when KB_LLM_PROVIDER is already set | pass |
| TC-347 | FR-26 | preserves createdAt on round-trip | pass |
| TC-350 | FR-26 | normalizes in memory without writing files | pass |
| TC-351 | FR-27 | splits on commas and newlines and trims | pass |
| TC-352 | FR-27 | drops empties | pass |
| TC-353 | FR-27 | trims, removes blanks, and de-duplicates preserving order | pass |
| TC-354 | FR-27 | matches bare names by basename at any depth | pass |
| TC-355 | FR-27 | anchors patterns that contain a slash | pass |
| TC-356 | FR-27 | honours a leading slash anchor | pass |
| TC-357 | FR-27 | trailing slash matches directories only (but still ignores their contents) | pass |
| TC-358 | FR-27 | supports * within a segment and ** across segments | pass |
| TC-359 | FR-27 | supports negation to re-include | pass |
| TC-360 | FR-27 | skips comments and blank lines | pass |
| TC-361 | FR-27 | an empty matcher ignores nothing | pass |
| TC-362 | FR-27 | normalizes backslashes and leading ./ in the tested path | pass |
| TC-363 | FR-27 | merges base patterns with a .kbignore file at the repo root | pass |
| TC-364 | FR-27 | works with no .kbignore present | pass |
| TC-381 | FR-29 | includes all three subcommands | pass |
| TC-382 | FR-29 | documents --since flag | pass |
| TC-383 | FR-29 | documents --base flag | pass |
| TC-384 | FR-29 | Given no reports, then returns empty message | pass |
| TC-385 | FR-29 | Given reports, then list includes run ID, command, and duration | pass |
| TC-386 | FR-29 | Given --command filter, then only matching command appears | pass |
| TC-387 | FR-29 | Given --limit 1, then only one row appears | pass |
| TC-388 | FR-29 | Given a known runId, then displays stage table | pass |
| TC-389 | FR-29 | Given a prefix of runId, then matches by prefix | pass |
| TC-390 | FR-29 | Given unknown runId, then throws not found error | pass |
| TC-391 | FR-29 | Given show with no runId, then throws usage error | pass |
| TC-392 | FR-29 | Given two init runs, then compare output contains stage names and deltas | pass |
| TC-393 | FR-29 | Given compare with --command init, then uses only init runs | pass |
| TC-394 | FR-29 | Given explicit runIds, then compares those two runs | pass |
| TC-395 | FR-29 | Given fewer than 2 runs, then throws with helpful message | pass |
| TC-396 | FR-29 | Given two runs with different stage sets, then union of stages appears in output | pass |
| TC-397 | FR-29 | Given compare output totals row, then Δms matches difference between runs | pass |
| TC-398 | FR-29 | Given --base filter, then only reports matching that base appear | pass |
| TC-399 | FR-29 | Given --base filter that matches nothing, then returns empty message | pass |
| TC-400 | FR-29 | Given --base combined with --command, then both filters apply | pass |
| TC-401 | FR-29 | Given --base filter, then compare uses only runs from that base | pass |
| TC-402 | FR-29 | Given no subcommand, then returns help text | pass |
| TC-403 | FR-29 | Given --help, then returns help text | pass |
| TC-404 | FR-29 | Given unknown subcommand, then throws with the subcommand name | pass |
| TC-405 | FR-30 | Given /skip, then returns skip without asking for descriptions | pass |
| TC-406 | FR-30 | Given blank input, then returns skip | pass |
| TC-407 | FR-30 | Given /cancel on name prompt, then returns cancel | pass |
| TC-408 | FR-30 | Given null read on name prompt, then returns cancel | pass |
| TC-409 | FR-30 | Given /complete with no items, then returns skip | pass |
| TC-410 | FR-30 | Given name then /cancel on description, then returns cancel | pass |
| TC-411 | FR-30 | Given multiple names one at a time, then returns items after /complete and /accept | pass |
| TC-412 | FR-30 | Given blank description for an item, then uses default | pass |
| TC-413 | FR-30 | Given each added item, then writes running list to output | pass |
| TC-414 | FR-30 | Given /reject after /complete, then restarts collection from the beginning | pass |
| TC-415 | FR-30 | Given /cancel on final confirmation, then returns cancel | pass |
| TC-416 | FR-31 | Given no apply flag, then defaults to preview (apply=false) | pass |
| TC-417 | FR-31 | Given apply and phase import, then parses explicit execution mode | pass |
| TC-418 | FR-31 | Given checkpoint and stop flags, then parses resume options | pass |
| TC-419 | FR-31 | Given a custom progress sink, then publish progress avoids direct stderr writes | pass |
| TC-420 | FR-31 | Given notion state with stale pages, then preview reports removedPages | pass |
| TC-421 | FR-31 | Given apply with notion state, then archives stale pages and returns removedPages | pass |
| TC-422 | FR-32 | repo list reports an empty base, then the added repo | pass |
| TC-423 | FR-32 | a bare repo command (no verb) lists | pass |
| TC-424 | FR-32 | rejects an unknown repo verb | pass |
| TC-425 | FR-32 | repo add clones, indexes, and appends to meta.json | pass |
| TC-426 | FR-32 | repo add rejects a duplicate slug | pass |
| TC-427 | FR-32 | repo remove purges the repo facts and drops it from meta | pass |
| TC-428 | FR-32 | repo remove refuses to remove the last repo | pass |
| TC-429 | FR-32 | lists, sets, adds, removes, and clears patterns | pass |
| TC-430 | FR-32 | rejects an unknown verb | pass |
| TC-431 | FR-32 | requires a pattern for add/remove/set | pass |
| TC-432 | FR-32 | preserves repos when editing ignore patterns | pass |
| TC-433 | FR-33 | Given more than TOP_SOURCE_PREVIEW_LIMIT hits, then footer says top N of M ranked | pass |
| TC-434 | FR-33 | Given at most TOP_SOURCE_PREVIEW_LIMIT hits, then footer says all M ranked | pass |
| TC-435 | FR-33 | Given no hits, then footer is (none) | pass |
| TC-436 | FR-34 | Given no existing skill files, then installs all agents and returns installed actions | pass |
| TC-437 | FR-34 | Given already-installed skill with matching hash, then action is skipped | pass |
| TC-438 | FR-34 | Given stale skill hash, then action is updated | pass |
| TC-439 | FR-34 | Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb | pass |
| TC-440 | FR-34 | Given ~/.claude/CLAUDE.md already has KB section, then action is already-present | pass |
| TC-441 | FR-34 | Given ~/.codex/AGENTS.md exists without KB section, then injects blurb | pass |
| TC-442 | FR-34 | Given neither profile MD exists, then creates ~/.claude/CLAUDE.md | pass |
| TC-443 | FR-34 | Given both profile MDs exist, then only injects into whichever lacks the section | pass |
| TC-444 | FR-34 | shows installed skill files and injected profile entries | pass |
| TC-445 | FR-34 | shows skipped skill files as up-to-date | pass |
| TC-446 | FR-34 | Given installed skill files, then removes them and reports removed | pass |
| TC-447 | FR-34 | Given no skill files, then action is not-found | pass |
| TC-448 | FR-34 | Given profile MD with injected section, then removes the section | pass |
| TC-449 | FR-34 | Given profile MD without KB section, then action is not-found | pass |
| TC-450 | FR-34 | Given removed results, then formats readable output | pass |
| TC-451 | FR-34 | Given no provider config dirs, then all results are not-installed | pass |
| TC-452 | FR-34 | Given Claude config dir exists with no settings.json, then creates settings.json with hook | pass |
| TC-453 | FR-34 | Given hook already installed at current path, then action is skipped | pass |
| TC-454 | FR-34 | Given hook installed at stale path, then updates to current path | pass |
| TC-455 | FR-34 | Given settings.json with existing hooks, then merges without clobbering | pass |
| TC-456 | FR-34 | Given Gemini config dir exists, then installs BeforeTool hook in settings.json | pass |
| TC-457 | FR-34 | Given Codex config dir exists, then installs hook in hooks.json | pass |
| TC-458 | FR-34 | Writes executable hook script to ~/.kb/hooks/kb-reminder.sh | pass |
| TC-459 | FR-34 | Given hook present in settings.json, then removes it | pass |
| TC-460 | FR-34 | Given no settings.json, then action is not-installed | pass |
| TC-461 | FR-34 | Given settings.json without KB hook, then action is not-installed | pass |
| TC-462 | FR-34 | Given hook plus other hooks in same matcher group, then only removes kb hook | pass |
| TC-463 | FR-34 | includes Agent hooks section when hook results provided | pass |
| TC-464 | FR-34 | omits Agent hooks section when hook results not provided | pass |
| TC-465 | FR-35 | greets the user | pass |
| TC-466 | FR-35 | lists the core commands | pass |
| TC-467 | FR-35 | tells the user how to get help | pass |
| TC-468 | FR-35 | is a non-empty string | pass |
| TC-469 | FR-35 | names the base in the notice | pass |
| TC-470 | FR-35 | points the user to server-managed indexing (KB_GIT_REPOS) | pass |
| TC-471 | FR-35 | suggests switching base via kb base use | pass |
| TC-472 | FR-35 | reflects the given base name exactly | pass |
| TC-486 | FR-36 | Given --help, then prints release-based sync help | pass |
| TC-487 | FR-36 | Given no flags, then sync installs the latest release tarball into ~/.kb and links a stable binary | pass |
| TC-488 | FR-36 | Given legacy no-build flag, then sync rejects it | pass |
| TC-489 | FR-36 | Given positional args, then sync rejects them | pass |
| TC-490 | FR-37 | client uninstall removes kb only and preserves kb-server + server data | pass |
| TC-494 | FR-37 | removes PATH entries from rc files only when both binaries are gone | pass |
| TC-495 | FR-37 | kb uninstall rejects --purge with kb-server guidance | pass |
| TC-496 | FR-37 | --yes removes client without prompting | pass |
| TC-537 | FR-37 | kb-server uninstall without purge keeps ~/.kb server data | pass |
| TC-538 | FR-37 | kb-server uninstall --purge removes server data but keeps kb client install | pass |
| TC-539 | FR-37 | kb-server uninstall --purge --yes deletes server data | pass |
| TC-499 | FR-38 | Given id selector, then parses normalized id mode | pass |
| TC-500 | FR-38 | Given title and base flags, then parses title mode with base | pass |
| TC-501 | FR-38 | Given id and title selectors together, then throws explicit error | pass |
| TC-502 | FR-38 | Given unknown flag, then throws explicit error | pass |
| TC-503 | FR-38 | Given no flags, then parses unlimited output by default | pass |
| TC-504 | FR-38 | Given flags, then parses limit and base | pass |
| TC-505 | FR-38 | Given positional arg, then throws explicit error | pass |
| TC-506 | FR-38 | Given document id, then prints full document body with metadata header | pass |
| TC-507 | FR-38 | Given exact title selector, then returns matching document | pass |
| TC-508 | FR-38 | Given missing document, then throws not found error | pass |
| TC-509 | FR-38 | Given duplicate exact title matches, then throws ambiguity error with exit code 2 | pass |
| TC-510 | FR-38 | Given documents in a base, then lists metadata in human output | pass |
| TC-511 | FR-38 | Given base filter, then returns document list for that base | pass |
| TC-512 | FR-38 | Given more than twenty documents, then docs list shows all by default | pass |

### Related docs

- [CLI.md](CLI.md)
- [TUI.md](../core/TUI.md)
