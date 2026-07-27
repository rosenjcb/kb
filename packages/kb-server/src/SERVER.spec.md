---
type: Spec
title: "Spec: KB HTTP, MCP, and Slack Server"
sources: [./, ./mcp-tools.ts, ./mcp-server.ts, ./mcp-feedback-elicitation.ts, ./pending-feedback-store.ts, ./query-feedback-store.ts]
tests: [../../../tests/server]
description: Behavioral specification for KB HTTP, MCP, and Slack Server
tags: [spec, kb]
timestamp: 2026-07-26T23:20:00Z
---

### Intro

Long-lived HTTP service with REST, optional MCP, and Slack. Stack wiring and invariants: [SERVER.md](./SERVER.md). Query pipeline: [QUERY_INTERNALS.md](../../kb-core/src/core/QUERY_INTERNALS.md). Chat reply presentation: [CHAT_REPLY.md](../../kb-core/src/service/CHAT_REPLY.md).

### Definitions

- **requestId** — singular server-assigned id on a `kb_query` payload / `x-request-id`; `submit_feedback` accepts one string `requestId` (never a `requestIds` array)
- **AGENT_INSTRUCTION** — top-level sampled feedback nudge on a trimmed `kb_query` payload (not inside `notes`)
- **KB_MCP_ELICITATION** — env flag; default `true` enables form elicitation + SSE POST; `false` opts out to JSON-only
- **KB_FEEDBACK_SAMPLE_RATE** — float 0–1; gates *whether* a trimmed `kb_query` asks for feedback (default `0` = off)

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- Black-box HTTP contract tests — see [`HTTP.spec.md`](../http/HTTP.spec.md)

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Stream chat synthesis over SSE |
| FR-2 | Expose authenticated REST routes for query, chat, and health; `/healthz` is liveness (HTTP 200 when reachable) with readiness in body (`ok` / `indexing`); includes `version.server` (not `@kb/core`); empty API-key list allows open access |
| FR-3 | KbService reads facts, reports health (`indexing` / `bootstrapProgress` / `reindexing`), and serializes reindex |
| FR-4 | Expose an answer-first MCP tool (`kb_query`) that always synthesizes and — together with `submit_feedback` (FR-19) and `get_feedback_requests` (FR-20) — never exposes other tools; the default payload is trimmed to the original query + answer + source citations, with the full evidence dump behind `verbose: true` |
| FR-5 | Parse and run periodic reindex scheduler |
| FR-6 | Serialize IntentResult to REST JSON, and to the trimmed MCP payload (answer + deduped/capped citations + verify/grounding notes) |
| FR-7 | Resolve bootstrap base, repos, branch, and ignore patterns from env and flags |
| FR-8 | Start server CLI with bootstrap logging and deferred scheduler |
| FR-9 | Print package version for `--version` / `-V` without starting the daemon |
| FR-10 | Store in-memory chat session history with TTL and caps |
| FR-11 | Verify Slack signatures, route events, and deduplicate retries; chat replies use `formatChatReply({ flavor: 'slack', sourceRepos })` on the same `service.chat` answer event as `/v1/chat` (Markdown→mrkdwn + deduped Sources footer; blob links from `discoverBaseRepos` per slug) |
| FR-12 | Manage the daemon by pid file: resolve the bind port, write/read the pid, and treat a dead pid as stopped |
| FR-13 | Generate a launchd/systemd service that launches the release binary (never a repo dist path) |
| FR-14 | Serve many bases from one process: select per request via `X-KB-Base` (or `?base=` / body `base`); omitted ⇒ default base, unknown ⇒ `404 unknown_base`; `GET /v1/bases` lists served bases |
| FR-15 | One-shot `kb-server scan` runs adopt(optional) → scan → export(optional) then exits (no HTTP); `--from`/`--out` are local paths only; batch always replaces an existing adopt index and overwrites `--out` (no `--force`); `--json` emits ok true/false summary on stdout |
| FR-16 | Browser CORS: reflect allow-listed `Origin` (or `*`); omit headers when CORS off / origin not listed; answer preflight `OPTIONS` with 204 without auth for allowed origins |
| FR-17 | First-boot bootstrap (`health.indexing`) returns 503 on `/v1/query`, `/v1/chat`, and `/mcp` with progress; scheduled reindex (`health.reindexing`) does **not** block those routes |
| FR-18 | One-shot `kb-server refresh` builds a fresh local snapshot dir for one base, from either a previous local snapshot (`--from`: adopt, re-clone/hydrate repos from `--repos`/`--branch`, incremental reindex) or bare repos with no previous snapshot (`--repos` only: full clone + index); `--from`/`--out` are local paths only (never object storage — no `gs://`/`s3://` awareness, no bucket credentials — matching the existing invariant `scan`/`export`/`import` already hold), while `--repos` is a plain `url[#branch]` list (the `KB_GIT_REPOS` convention). It manages its own throwaway bootstrap child process (spawn, health-poll, SIGTERM-then-SIGKILL on completion or timeout) internally so callers no longer hand-roll that in shell. The child's stdout/stderr are routed into this process's own stderr (fd 2) rather than discarded, so a long-running cold index of a large repo stays observable live in `docker logs`/the container's own log stream instead of silently vanishing; `--json` emits an ok/error summary on stdout, same contract style as `scan`, and is unaffected since the child's output never touches this process's own stdout (fd 1) |
| FR-19 | [UPDATED] Expose a `submit_feedback` MCP tool that records agent feedback (`helped` = yes/partial/no plus optional notes/answer/query/requestId/0–4 axis scores — one string `requestId` per call, no `requestIds` array; omit it for general feedback) as NDJSON under `$KB_HOME/feedback/<YYYY-MM-DD>.jsonl` without ever failing the response, echoing the full recorded feedback back for confirmation and resolving any matching pending-feedback entry (FR-20); echo the server `requestId` in kb_query MCP payloads for correlation; and on a sampled fraction of trimmed kb_query responses (`KB_FEEDBACK_SAMPLE_RATE`, float 0–1, default 0 = off) prefer MCP form elicitation when FR-21 applies, else set a top-level `AGENT_INSTRUCTION` key (never buried inside `notes`) |
| FR-20 | [UPDATED] Queue each sampled `AGENT_INSTRUCTION` nudge's `requestId`/`query` as a pending-feedback entry (in-memory, TTL-capped, process-local) and expose it read-only via `get_feedback_requests`; an entry is removed once `submit_feedback` reports on its `requestId`; successful elicitation (FR-21 accept) records feedback immediately and does not enqueue |
| FR-21 | [NEW] When a sampled kb_query has an `elicitFeedback` hook (wired when `KB_MCP_ELICITATION` is on — default `true`, opt out with `false`): accept records durable feedback and sets `feedback.via=elicitation` without `AGENT_INSTRUCTION`/pending; decline/cancel sets `feedback.status` without recording or nudging; `unavailable` falls back to FR-19's `AGENT_INSTRUCTION` + FR-20 queue |
| FR-22 | [NEW] MCP `/mcp` is stateful Streamable HTTP: initialize returns `mcp-session-id` and subsequent POST/GET/DELETE must send it; when elicitation is on (FR-21 default) POST responses use SSE so `elicitation/create` can ride the tool-call stream, and `KB_MCP_ELICITATION=false` uses JSON-only POST responses |
| FR-23 | [NEW] `createServerElicitFeedback`, bound to a live MCP `Server`, is the `elicitFeedback` hook consumed by FR-21: it checks the client's declared `elicitation` capability before asking (declining to ask at all when unsupported), dispatches a form-mode `elicitation/create` request (message + the flat helped/notes schema) via `elicitInput` when the client declared explicit `form` support or a raw `server.request()` fallback for the spec-back-compat empty-object case, maps the client's response to accepted/dismissed/unavailable, and never throws — a rejected/erroring request also resolves to `unavailable` |

### Known issues

- **Id-sequence debt**: the QA table carries pre-existing violations of the contiguous-ascending id rule (`TC-3b`, `TC-109b`, and a missing `TC-9`), so `spec-md lint --strict` fails on this file. The repair is a full renumber to `TC-1..TC-n` with matching `[TC-N]` tag updates across `tests/server/` — deferred to a dedicated change to keep feature diffs reviewable.
- **Scope boundary**: `refresh` deliberately does *not* replace the object-store pull/push/pointer-flip/prune steps in `scripts/gcp/refresh.sh` / `scripts/fly/refresh.sh` — those stay in the shell layer by design, so this FR only covers the "build one fresh snapshot dir" portion of the builder flow, not the whole publish pipeline.

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | streams reasoning then a terminal answer and done | pass |
| TC-2 | FR-1 | emits an error event when synthesis throws | pass |
| TC-3 | FR-2 | serves /healthz without auth | pass |
| TC-3b | FR-2 | returns 200 on /healthz while bootstrap indexing (liveness; ok=false in body) | pass |
| TC-4 | FR-2 | rejects /v1/query without a valid key | pass |
| TC-5 | FR-2 | answers /v1/query with a serialized body when authorized | pass |
| TC-6 | FR-2 | returns 503 for /v1/query while the server is bootstrapping its first index | pass |
| TC-7 | FR-2 | returns 400 when q is missing | pass |
| TC-10 | FR-2 | streams /v1/chat as SSE with a session id, answer, and done | pass |
| TC-11 | FR-2 | returns 400 when chat message is missing | pass |
| TC-12 | FR-2 | 404s on unknown routes and when MCP is disabled | pass |
| TC-13 | FR-2 | writes a RunReport to disk for /v1/query | pass |
| TC-14 | FR-2 | writes an error RunReport when /v1/query fails | pass |
| TC-15 | FR-2 | does not write a RunReport for /healthz | pass |
| TC-16 | FR-3 | scans the repos discovered on the base volume | pass |
| TC-17 | FR-3 | readFacts returns matching facts from the on-disk index | pass |
| TC-18 | FR-3 | health reports the base name and a present index mtime | pass |
| TC-19 | FR-3 | serializes concurrent reindex calls via the in-process guard | pass |
| TC-20 | FR-3 | health reports indexing while background bootstrap is still running | pass |
| TC-21 | FR-4 | exposes exactly kb_query, submit_feedback, and get_feedback_requests, never the former registry tools or upsert_fact | pass |
| TC-22 | FR-4 | always synthesizes an answer (answer-first, no synthesize flag) | pass |
| TC-23 | FR-4 | errors when kb_query is missing q | pass |
| TC-24 | FR-4 | refuses former registry tools like kb_read_facts | pass |
| TC-25 | FR-4 | refuses tools outside the allowlist | pass |
| TC-26 | FR-5 | parses unit suffixes | pass |
| TC-27 | FR-5 | treats bare numbers as milliseconds | pass |
| TC-28 | FR-5 | defaults to one hour when unset or empty | pass |
| TC-29 | FR-5 | returns 0 (disabled) for "0" | pass |
| TC-30 | FR-5 | returns undefined for malformed values | pass |
| TC-31 | FR-5 | is inert when interval <= 0 | pass |
| TC-32 | FR-5 | runs ticks and skips overlapping runs | pass |
| TC-33 | FR-5 | does not emit a completion line when a tick is intentionally skipped | pass |
| TC-34 | FR-6 | maps a read_facts IntentResult into the REST response body | pass |
| TC-35 | FR-6 | returns null answer when none is present | pass |
| TC-36 | FR-7 | splits on commas and whitespace, preserving inline #branch | pass |
| TC-37 | FR-7 | handles newline-separated multi-line values and ignores blanks | pass |
| TC-38 | FR-7 | applies the default branch only when no inline branch is given | pass |
| TC-39 | FR-7 | returns [] for undefined/empty | pass |
| TC-40 | FR-7 | resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE) | pass |
| TC-41 | FR-7 | lets the --base flag win over env | pass |
| TC-42 | FR-7 | reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS) | pass |
| TC-43 | FR-7 | lets --git flags win over env repos | pass |
| TC-44 | FR-7 | reads ignore patterns from KB_SERVER_IGNORE | pass |
| TC-45 | FR-7 | reports source "none" and no ignore when nothing is declared | pass |
| TC-46 | FR-7 | applies --branch as the default branch for targets without an inline pin | pass |
| TC-47 | FR-8 | forwards background init progress lines into server logging | pass |
| TC-48 | FR-8 | starts the reindex scheduler only after bootstrap init completes | pass |
| TC-49 | FR-9 | Given `kb-server --version`, prints version and does not listen | pass |
| TC-50 | FR-10 | returns empty history for an unknown session | pass |
| TC-51 | FR-10 | appends user/assistant turns and reads them back | pass |
| TC-52 | FR-10 | trims to the configured turn cap | pass |
| TC-53 | FR-10 | evicts sessions past their TTL | pass |
| TC-54 | FR-10 | clear removes a single session | pass |
| TC-55 | FR-11 | returns true for a valid signature | pass |
| TC-56 | FR-11 | returns false when signature is wrong | pass |
| TC-57 | FR-11 | returns false when timestamp is missing | pass |
| TC-58 | FR-11 | returns false when signature is missing | pass |
| TC-59 | FR-11 | returns false when timestamp is older than 5 minutes (replay attack) | pass |
| TC-60 | FR-11 | returns false when signing secret is wrong | pass |
| TC-61 | FR-11 | strips a single leading mention | pass |
| TC-62 | FR-11 | strips multiple leading mentions | pass |
| TC-63 | FR-11 | leaves text unchanged when no mention is present | pass |
| TC-64 | FR-11 | returns empty string when only a mention is present | pass |
| TC-65 | FR-11 | returns false the first time an event_id is seen | pass |
| TC-66 | FR-11 | returns true for a repeated event_id | pass |
| TC-67 | FR-11 | rejects unsigned requests with 401 | pass |
| TC-68 | FR-11 | rejects requests with a wrong secret | pass |
| TC-69 | FR-11 | rejects stale-timestamp requests | pass |
| TC-70 | FR-11 | echoes the challenge for url_verification | pass |
| TC-71 | FR-11 | acks 200 for an app_mention event | pass |
| TC-72 | FR-11 | acks 200 for a DM message event | pass |
| TC-73 | FR-11 | acks 200 for a threaded app_mention (chat mode) | pass |
| TC-74 | FR-11 | ignores bot messages to prevent reply loops | pass |
| TC-75 | FR-11 | deduplicates events with the same event_id | pass |
| TC-76 | FR-11 | returns 404 when slack is not configured | pass |
| TC-77 | FR-11 | posts indexing progress first, then answers after bootstrap settles | pass |
| TC-78 | FR-12 | resolveDaemonPort reads --port, then PORT, then the default | pass |
| TC-79 | FR-12 | writePidFile/readLivePid round-trips the running pid | pass |
| TC-80 | FR-12 | readLivePid returns null for a stale pid file (dead process) | pass |
| TC-81 | FR-13 | service install --no-start writes a unit that invokes the resolved binary | pass |
| TC-82 | FR-14 | routes /v1/query to the base named by X-KB-Base | pass |
| TC-83 | FR-14 | falls back to the default base when no header is sent | pass |
| TC-84 | FR-14 | returns 404 unknown_base for a base with no index | pass |
| TC-85 | FR-14 | honors a body base override on /v1/query | pass |
| TC-86 | FR-14 | /healthz?base= reports the named base | pass |
| TC-87 | FR-14 | GET /v1/bases lists every served base | pass |
| TC-88 | FR-14 | registry resolves the default base without building | pass |
| TC-89 | FR-14 | registry lazily creates and caches another built base | pass |
| TC-90 | FR-14 | registry throws BaseNotFoundError for a base with no index | pass |
| TC-91 | FR-14 | registry list() advertises the default plus every built base | pass |
| TC-92 | FR-15 | adopt(--from) → scan → export(--out) round-trips on local paths | pass |
| TC-93 | FR-15 | scans a warm base in place with no --from / --out | pass |
| TC-94 | FR-15 | --json emits a single machine-readable success summary on stdout | pass |
| TC-95 | FR-15 | rejects object-store URIs for --from | pass |
| TC-96 | FR-15 | rejects object-store URIs for --out | pass |
| TC-97 | FR-15 | overwrites a non-empty --out without --force | pass |
| TC-98 | FR-15 | --json emits { ok: false } on stdout before rethrowing | pass |
| TC-99 | FR-15 | --from replaces an existing base index without --force | pass |
| TC-100 | FR-11 | appends a Sources footer from the chat answer event (shared with HTTP chat) | pass |
| TC-101 | FR-11 | posts per-repo blob links from discoverBaseRepos (slug → gitUrl + primary branch) | pass |
| TC-102 | FR-16 | omits CORS headers when no origins are allowed | pass |
| TC-103 | FR-16 | reflects an allow-listed origin and varies on Origin | pass |
| TC-104 | FR-16 | does not reflect an origin outside the allow-list | pass |
| TC-105 | FR-16 | echoes `*` when any origin is allowed | pass |
| TC-106 | FR-16 | answers preflight OPTIONS with 204 and no auth for an allowed origin | pass |
| TC-107 | FR-16 | rejects preflight OPTIONS from a disallowed origin with 405 | pass |
| TC-108 | FR-17 | serves `/v1/query` while scheduled reindex is in progress (not bootstrap) | pass |
| TC-109 | FR-4 | default response is answer + compact citations, no fact dump or retrieval metadata | pass |
| TC-109b | FR-4 | advertises the verbose flag in the tool schema | pass |
| TC-110 | FR-4 | verbose:true opts into the full evidence payload | pass |
| TC-111 | FR-6 | trims to answer + citations and drops retrieval metadata and the fact dump | pass |
| TC-112 | FR-6 | adds a verify note when confidence is below the threshold | pass |
| TC-113 | FR-6 | dedupes citations per file, folds in symbols, and caps the list at 5 | pass |
| TC-114 | FR-6 | flags answer file references that match no cited source path | pass |
| TC-115 | FR-6 | notes when sources exist but no answer was synthesized | pass |
| TC-116 | FR-6 | grounding matches by basename so relative prose paths ground against absolute evidence paths | pass |
| TC-117 | FR-6 | grounding ignores non-file tokens: product names, property access, bare words | pass |
| TC-118 | FR-6 | grounding reports each ungrounded file once | pass |
| TC-119 | FR-18 | warm: given `--from <prior-snapshot>` and `--repo`/`--branch`, adopts the prior index, re-clones the repo, and reindexes only changed files at `--out` | pass |
| TC-120 | FR-18 | cold: given `--repo` with no `--from`, clones fresh and produces a full index at `--out` | pass |
| TC-121 | FR-18 | cold mode with neither `--from` nor `--repo` errors instead of hanging | pass |
| TC-122 | FR-18 | surfaces the child bootstrap's `bootstrapError` as a failure instead of waiting out the full timeout | pass |
| TC-123 | FR-18 | returns a timeout error (not a hang) when bootstrap never reaches `ok:true` | pass |
| TC-124 | FR-18 | `--json` emits a single `{ ok: true, ... }` summary on stdout on success | pass |
| TC-125 | FR-18 | `--json` emits `{ ok: false, error }` on stdout before the process exits non-zero on failure | pass |
| TC-126 | FR-18 | rejects `gs://`/`s3://`-scheme values for `--from`/`--out` (local-paths-only invariant; `--repos` legitimately holds `https://`/`git@` git URLs and is exempt) | pass |
| TC-127 | FR-18 | terminates its bootstrap child process (no orphan) after both success and timeout | pass |
| TC-128 | FR-18 | routes the bootstrap child's stdout/stderr into this process's own stderr (fd 2) instead of `stdio: 'ignore'` | pass |
| TC-129 | FR-19 | submit_feedback records helped/notes/answer/query/requestId/scores as an NDJSON feedback record and returns ok | pass |
| TC-130 | FR-19 | submit_feedback errors when helped is missing or not yes/partial/no | pass |
| TC-131 | FR-19 | kb_query MCP payload echoes the server requestId for feedback correlation | pass |
| TC-132 | FR-19 | sets a top-level AGENT_INSTRUCTION nudge (not buried in notes) when the sampling gate passes | pass |
| TC-133 | FR-19 | sets no AGENT_INSTRUCTION when KB_FEEDBACK_SAMPLE_RATE is unset or 0 (default off) | pass |
| TC-134 | FR-4 | kb_query response echoes back the original query text | pass |
| TC-135 | FR-19 | submit_feedback response echoes back the submitted query when provided, omits it when absent | pass |
| TC-136 | FR-19 | submit_feedback records and echoes back the submitted answer text when provided | pass |
| TC-137 | FR-19 | submit_feedback response echoes the full recorded feedback (helped/notes/requestId/scores), not just query/answer | pass |
| TC-138 | FR-19 | submit_feedback rejects a non-string requestId (no array batching) | pass |
| TC-139 | FR-20 | get_feedback_requests lists a pending entry queued by a sampled nudge, and submit_feedback resolves it | pass |
| TC-140 | FR-20 | submit_feedback with no requestId is valid general feedback and leaves the pending queue untouched | pass |
| TC-141 | FR-21 | sampled kb_query with elicitFeedback accept records feedback via elicitation and skips AGENT_INSTRUCTION/pending | pass |
| TC-142 | FR-21 | sampled kb_query with elicitFeedback decline/cancel skips recording, AGENT_INSTRUCTION, and pending | pass |
| TC-143 | FR-21 | sampled kb_query with elicitFeedback unavailable falls back to AGENT_INSTRUCTION + pending | pass |
| TC-144 | FR-21 | KB_MCP_ELICITATION defaults to true (unset/empty/`true`); only `false` opts out | pass |
| TC-145 | FR-22 | MCP POST without session (non-initialize) or GET without `mcp-session-id` returns 400 | pass |
| TC-146 | FR-23 | no elicitation capability declared: resolves unavailable without calling elicitInput or request | pass |
| TC-147 | FR-23 | client declares only url-mode capability (no form): resolves unavailable without asking | pass |
| TC-148 | FR-23 | client declares empty `elicitation: {}` (back-compat form-only): dispatches via the raw `server.request()` fallback, not `elicitInput` | pass |
| TC-149 | FR-23 | client declares explicit `elicitation: { form: {} }`: dispatches via `server.elicitInput()` | pass |
| TC-150 | FR-23 | client responds accept with a valid helped value: resolves accepted with helped/notes | pass |
| TC-151 | FR-23 | client responds accept with a missing or invalid helped value: resolves unavailable | pass |
| TC-152 | FR-23 | client responds decline: resolves dismissed with action decline | pass |
| TC-153 | FR-23 | client responds cancel: resolves dismissed with action cancel | pass |
| TC-154 | FR-23 | the client request rejects: resolves unavailable instead of throwing | pass |

### Related docs

- [SERVER.md](SERVER.md)
- [FLY.md](../FLY.md) — Pages chatbot host (`kb-demo`)
- [demo/README.md](../../../demo/README.md) — browser client wait-for-bootstrap
- [CHAT_REPLY.md](../../kb-core/src/service/CHAT_REPLY.md) — shared answer/sources presentation
- [QUERY_INTERNALS.md](../../kb-core/src/core/QUERY_INTERNALS.md)
