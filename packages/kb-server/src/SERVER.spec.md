---
type: Spec
title: "Spec: KB HTTP, MCP, and Slack Server"
sources: [./, ./mcp-tools.ts, ./mcp-server.ts, ./mcp-feedback-elicitation.ts, ./pending-feedback-store.ts, ./query-feedback-store.ts]
tests: [../../../tests/server]
description: Behavioral specification for KB HTTP, MCP, and Slack Server
tags: [spec, kb]
timestamp: 2026-08-16T00:15:00Z
---

### Intro

Long-lived HTTP service with REST, optional MCP, and Slack. Stack wiring and invariants: [SERVER.md](./SERVER.md). Query pipeline: [QUERY_INTERNALS.md](../../kb-core/src/core/QUERY_INTERNALS.md). Chat reply presentation: [CHAT_REPLY.md](../../kb-core/src/service/CHAT_REPLY.md).

### Definitions

- **requestId** — singular server-assigned id on a `query` payload / `x-request-id`; `submit_feedback` accepts one string `requestId` (never a `requestIds` array)
- **AGENT_INSTRUCTION** — top-level sampled feedback nudge on a trimmed `query` payload (not inside `notes`)
- **KB_MCP_ELICITATION** — env flag; default `true` enables form elicitation + SSE POST; `false` opts out to JSON-only
- **KB_FEEDBACK_SAMPLE_RATE** — float 0–1; gates *whether* a trimmed `query` asks for feedback (default `0` = off)

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
| FR-4 | [UPDATED] Expose an answer-first MCP tool (`query`) that always synthesizes and — together with `submit_feedback` (FR-19) and `get_feedback_requests` (FR-20) — never exposes other tools; the default payload is lean (`query` + `answer` + `{path, symbols?}` sources + evidence/notes), with the full evidence dump behind `verbose: true`; an optional `base` argument overrides the MCP session's default base for that one call, the same per-call override FR-14's body `base` already offers over REST — an unresolvable slug is an error result (not a 404, MCP has no status codes) and a single-base server (no registry) ignores it |
| FR-5 | Parse and run periodic reindex scheduler |
| FR-6 | [UPDATED] Serialize IntentResult to a lean agent JSON body by default (MCP + REST: answer + `{path, symbols?}` sources + evidence/notes); `verbose: true` returns the full dump (GroupedSource with facts, raw `results`, `retrieval`); an answer that cites a file not among the retrieved sources downgrades `evidence` (not just a note), matching a path-qualified citation against the full source path (or a path suffix) and a bare filename against basename only |
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
| FR-19 | [UPDATED] Expose a `submit_feedback` MCP tool that records agent feedback (`helped` = yes/partial/no plus optional notes/answer/query/requestId/0–4 axis scores — one string `requestId` per call, no `requestIds` array; omit it for general feedback) as NDJSON under `$KB_HOME/feedback/<YYYY-MM-DD>.jsonl` without ever failing the response, echoing the full recorded feedback back for confirmation and resolving any matching pending-feedback entry (FR-20); echo the server `requestId` in query MCP payloads for correlation; and on a sampled fraction of trimmed query responses (`KB_FEEDBACK_SAMPLE_RATE`, float 0–1, default 0 = off) prefer MCP form elicitation when FR-21 applies, else set a top-level `AGENT_INSTRUCTION` key (never buried inside `notes`) |
| FR-20 | [UPDATED] Queue each sampled `AGENT_INSTRUCTION` nudge's `requestId`/`query` as a pending-feedback entry (in-memory, TTL-capped, process-local) and expose it read-only via `get_feedback_requests`; an entry is removed once `submit_feedback` reports on its `requestId`; successful elicitation (FR-21 accept) records feedback immediately and does not enqueue |
| FR-21 | [NEW] When a sampled query has an `elicitFeedback` hook (wired when `KB_MCP_ELICITATION` is on — default `true`, opt out with `false`): accept records durable feedback and sets `feedback.via=elicitation` without `AGENT_INSTRUCTION`/pending; decline/cancel sets `feedback.status` without recording or nudging; `unavailable` falls back to FR-19's `AGENT_INSTRUCTION` + FR-20 queue |
| FR-22 | [NEW] MCP `/mcp` is stateful Streamable HTTP: initialize returns `mcp-session-id` and subsequent POST/GET/DELETE must send it; when elicitation is on (FR-21 default) POST responses use SSE so `elicitation/create` can ride the tool-call stream, and `KB_MCP_ELICITATION=false` uses JSON-only POST responses |
| FR-23 | [NEW] `createServerElicitFeedback`, bound to a live MCP `Server`, is the `elicitFeedback` hook consumed by FR-21: it checks the client's declared `elicitation` capability before asking (declining to ask at all when unsupported), dispatches a form-mode `elicitation/create` request (message + the flat helped/notes schema) via `elicitInput` when the client declared explicit `form` support or a raw `server.request()` fallback for the spec-back-compat empty-object case, maps the client's response to accepted/dismissed/unavailable, and never throws — a rejected/erroring request also resolves to `unavailable` |
| FR-24 | [NEW] Never present a failed LLM call as an answer: when synthesis throws or returns nothing, carry a structured `answerError` (stage/kind/message/provider/status/retryable) on the REST and MCP payloads with that failure leading `notes`, suppress the sampled feedback ask, and record the RunReport as an error; surface best-effort stage failures (scope inference, curation) on `retrieval.degraded`; a chat turn whose model returns no text emits an `error` event rather than a canned "not enough information" answer |
| FR-25 | [NEW] Base lifecycle is an operator action on `kb-server`, never the `kb` client. The target base is always the explicit `--base <name>` flag (no positional, no implicit default). `kb-server base` exposes `create --base <name> --git <url>…` (new named base, at least one repo required), `add-repo --base <name> --git <url>…` (attach repos to an existing base and re-index; allowed on the empty built-in `default` base), `list`, and `delete --base <name>` (prompts unless `--yes`). `create` refuses the reserved `default` slug and any base that already exists; `add-repo` refuses an unknown non-`default` base; all three error when `--base` is missing. |
| FR-26 | [NEW] Each `/v1/chat` turn writes its run report with a length-capped transcript (`turns`: the user message plus the assistant answer) so a session is reconstructable from its logs after `/clear`; an errored turn still captures the user line. |

### Known issues

- **Scope boundary**: `refresh` deliberately does *not* replace the object-store pull/push/pointer-flip/prune steps in `scripts/gcp/refresh.sh` / `scripts/fly/refresh.sh` — those stay in the shell layer by design, so this FR only covers the "build one fresh snapshot dir" portion of the builder flow, not the whole publish pipeline.

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-WH6M | FR-1 | streams reasoning then a terminal answer and done | pass |
| TC-K61F | FR-1 | emits an error event when synthesis throws | pass |
| TC-HTRQ | FR-2 | serves /healthz without auth | pass |
| TC-CASW | FR-2 | returns 200 on /healthz while bootstrap indexing (liveness; ok=false in body) | pass |
| TC-2DUM | FR-2 | rejects /v1/query without a valid key | pass |
| TC-BY16 | FR-2 | [UPDATED] answers /v1/query with a lean agent body when authorized (no `results`/`retrieval`) | pass |
| TC-B7TH | FR-2 | forwards trace: true to the service query pipeline | pass |
| TC-RRE8 | FR-2 | returns 503 for /v1/query while the server is bootstrapping its first index | pass |
| TC-ZXE4 | FR-2 | returns 400 when q is missing | pass |
| TC-E2AA | FR-2 | streams /v1/chat as SSE with a session id, answer, and done | pass |
| TC-UHQY | FR-2 | returns 400 when chat message is missing | pass |
| TC-G9U9 | FR-2 | 404s on unknown routes and when MCP is disabled | pass |
| TC-O3AH | FR-2 | writes a RunReport to disk for /v1/query | pass |
| TC-C18R | FR-2 | writes an error RunReport when /v1/query fails | pass |
| TC-PFPE | FR-2 | does not write a RunReport for /healthz | pass |
| TC-GAGS | FR-3 | scans the repos discovered on the base volume | pass |
| TC-I3L5 | FR-3 | readFacts returns matching facts from the on-disk index | pass |
| TC-RS4U | FR-3 | health reports the base name and a present index mtime | pass |
| TC-M0WU | FR-3 | serializes concurrent reindex calls via the in-process guard | pass |
| TC-2L4T | FR-3 | health reports indexing while background bootstrap is still running | pass |
| TC-NFCZ | FR-4 | exposes exactly query, submit_feedback, and get_feedback_requests, never the former registry tools or upsert_fact | pass |
| TC-3391 | FR-4 | always synthesizes an answer (answer-first, no synthesize flag) | pass |
| TC-XZYJ | FR-4 | errors when query is missing q | pass |
| TC-ILZU | FR-4 | refuses former registry tools like kb_read_facts | pass |
| TC-OYMN | FR-4 | refuses tools outside the allowlist | pass |
| TC-8JUE | FR-5 | parses unit suffixes | pass |
| TC-RGFH | FR-5 | treats bare numbers as milliseconds | pass |
| TC-GE9E | FR-5 | defaults to one hour when unset or empty | pass |
| TC-I665 | FR-5 | returns 0 (disabled) for "0" | pass |
| TC-LFY8 | FR-5 | returns undefined for malformed values | pass |
| TC-WBZA | FR-5 | is inert when interval <= 0 | pass |
| TC-7K0Z | FR-5 | runs ticks and skips overlapping runs | pass |
| TC-K7IT | FR-5 | does not emit a completion line when a tick is intentionally skipped | pass |
| TC-17SF | FR-6 | maps a read_facts IntentResult into the REST response body | pass |
| TC-0CD9 | FR-6 | returns null answer when none is present | pass |
| TC-6JDU | FR-7 | splits on commas and whitespace, preserving inline #branch | pass |
| TC-6SG4 | FR-7 | handles newline-separated multi-line values and ignores blanks | pass |
| TC-O0YC | FR-7 | applies the default branch only when no inline branch is given | pass |
| TC-C759 | FR-7 | returns [] for undefined/empty | pass |
| TC-L9F8 | FR-7 | resolves base from KB_SERVER_BASE_NAME (preferred over KB_BASE) | pass |
| TC-JT2B | FR-7 | lets the --base flag win over env | pass |
| TC-C3QO | FR-7 | reads repos from KB_SERVER_BASE_GIT_REPOS (preferred over KB_GIT_REPOS) | pass |
| TC-Z0WI | FR-7 | lets --git flags win over env repos | pass |
| TC-PNLO | FR-7 | reads ignore patterns from KB_SERVER_IGNORE | pass |
| TC-H3UU | FR-7 | reports source "none" and no ignore when nothing is declared | pass |
| TC-NAUJ | FR-7 | applies --branch as the default branch for targets without an inline pin | pass |
| TC-YOW6 | FR-8 | forwards background init progress lines into server logging | pass |
| TC-82TT | FR-8 | starts the reindex scheduler only after bootstrap init completes | pass |
| TC-QFNG | FR-9 | Given `kb-server --version`, prints version and does not listen | pass |
| TC-ZVM0 | FR-10 | returns empty history for an unknown session | pass |
| TC-M11P | FR-10 | appends user/assistant turns and reads them back | pass |
| TC-U3NT | FR-10 | trims to the configured turn cap | pass |
| TC-IPPR | FR-10 | evicts sessions past their TTL | pass |
| TC-K2EH | FR-10 | clear removes a single session | pass |
| TC-7FF5 | FR-11 | returns true for a valid signature | pass |
| TC-6GIP | FR-11 | returns false when signature is wrong | pass |
| TC-4AT0 | FR-11 | returns false when timestamp is missing | pass |
| TC-YBO5 | FR-11 | returns false when signature is missing | pass |
| TC-RIO7 | FR-11 | returns false when timestamp is older than 5 minutes (replay attack) | pass |
| TC-BXZC | FR-11 | returns false when signing secret is wrong | pass |
| TC-FIP4 | FR-11 | strips a single leading mention | pass |
| TC-GHTY | FR-11 | strips multiple leading mentions | pass |
| TC-3CDL | FR-11 | leaves text unchanged when no mention is present | pass |
| TC-SJUX | FR-11 | returns empty string when only a mention is present | pass |
| TC-5GXX | FR-11 | returns false the first time an event_id is seen | pass |
| TC-E18V | FR-11 | returns true for a repeated event_id | pass |
| TC-XYV2 | FR-11 | rejects unsigned requests with 401 | pass |
| TC-LM0V | FR-11 | rejects requests with a wrong secret | pass |
| TC-OHU0 | FR-11 | rejects stale-timestamp requests | pass |
| TC-7ZRK | FR-11 | echoes the challenge for url_verification | pass |
| TC-J94M | FR-11 | acks 200 for an app_mention event | pass |
| TC-VZHH | FR-11 | acks 200 for a DM message event | pass |
| TC-O9G8 | FR-11 | acks 200 for a threaded app_mention (chat mode) | pass |
| TC-QA15 | FR-11 | ignores bot messages to prevent reply loops | pass |
| TC-CHV2 | FR-11 | deduplicates events with the same event_id | pass |
| TC-TXCQ | FR-11 | returns 404 when slack is not configured | pass |
| TC-UO2O | FR-11 | posts indexing progress first, then answers after bootstrap settles | pass |
| TC-SYYS | FR-12 | resolveDaemonPort reads --port, then PORT, then the default | pass |
| TC-9GUC | FR-12 | writePidFile/readLivePid round-trips the running pid | pass |
| TC-N9EM | FR-12 | readLivePid returns null for a stale pid file (dead process) | pass |
| TC-59ML | FR-13 | service install --no-start writes a unit that invokes the resolved binary | pass |
| TC-LV2C | FR-14 | routes /v1/query to the base named by X-KB-Base | pass |
| TC-VYBU | FR-14 | falls back to the default base when no header is sent | pass |
| TC-TGKF | FR-14 | returns 404 unknown_base for a base with no index | pass |
| TC-ST1F | FR-14 | honors a body base override on /v1/query | pass |
| TC-AE0N | FR-14 | /healthz?base= reports the named base | pass |
| TC-NUXG | FR-14 | GET /v1/bases lists every served base | pass |
| TC-SHF7 | FR-14 | registry resolves the default base without building | pass |
| TC-VOAQ | FR-14 | registry lazily creates and caches another built base | pass |
| TC-K2XB | FR-14 | registry throws BaseNotFoundError for a base with no index | pass |
| TC-BNWZ | FR-14 | registry list() advertises the default plus every built base | pass |
| TC-WEY5 | FR-15 | adopt(--from) → scan → export(--out) round-trips on local paths | pass |
| TC-H0IH | FR-15 | scans a warm base in place with no --from / --out | pass |
| TC-LNWR | FR-15 | --json emits a single machine-readable success summary on stdout | pass |
| TC-48DJ | FR-15 | rejects object-store URIs for --from | pass |
| TC-1YZC | FR-15 | rejects object-store URIs for --out | pass |
| TC-9EV9 | FR-15 | overwrites a non-empty --out without --force | pass |
| TC-TAPM | FR-15 | --json emits { ok: false } on stdout before rethrowing | pass |
| TC-LQ4S | FR-15 | --from replaces an existing base index without --force | pass |
| TC-1I8S | FR-11 | appends a Sources footer from the chat answer event (shared with HTTP chat) | pass |
| TC-6LCA | FR-11 | posts per-repo blob links from discoverBaseRepos (slug → gitUrl + primary branch) | pass |
| TC-7GMP | FR-16 | omits CORS headers when no origins are allowed | pass |
| TC-6U7T | FR-16 | reflects an allow-listed origin and varies on Origin | pass |
| TC-7IKA | FR-16 | does not reflect an origin outside the allow-list | pass |
| TC-TIO4 | FR-16 | echoes `*` when any origin is allowed | pass |
| TC-8YQ4 | FR-16 | answers preflight OPTIONS with 204 and no auth for an allowed origin | pass |
| TC-VMNX | FR-16 | rejects preflight OPTIONS from a disallowed origin with 405 | pass |
| TC-F9NB | FR-17 | serves `/v1/query` while scheduled reindex is in progress (not bootstrap) | pass |
| TC-741S | FR-4 | [UPDATED] default response is answer + lean `{path, symbols?}` citations, no fact dump or retrieval metadata | pass |
| TC-O6P7 | FR-4 | advertises the verbose flag in the tool schema | pass |
| TC-ONSY | FR-4 | verbose:true opts into the full evidence payload | pass |
| TC-7277 | FR-6 | [UPDATED] trims to answer + lean citations and drops retrieval metadata and the fact dump | pass |
| TC-Q93N | FR-6 | adds a verify note when evidence is below the floor | pass |
| TC-B7DG | FR-6 | dedupes citations per file, folds in symbols, and caps the list at 5 | pass |
| TC-8URR | FR-6 | flags answer file references that match no cited source path | pass |
| TC-OADK | FR-6 | notes when sources exist but no answer was synthesized | pass |
| TC-LB44 | FR-6 | grounding matches by basename so relative prose paths ground against absolute evidence paths | pass |
| TC-1NET | FR-6 | grounding ignores non-file tokens: product names, property access, bare words | pass |
| TC-L52G | FR-6 | grounding reports each ungrounded file once | pass |
| TC-C4IU | FR-6 | [UPDATED] full/verbose serializer exposes source-centric `sources` (files, symbols folded, non-openable dropped) alongside raw `results` | pass |
| TC-UDIJ | FR-18 | warm: given `--from <prior-snapshot>` and `--repo`/`--branch`, adopts the prior index, re-clones the repo, and reindexes only changed files at `--out` | pass |
| TC-NHDZ | FR-18 | cold: given `--repo` with no `--from`, clones fresh and produces a full index at `--out` | pass |
| TC-N0NE | FR-18 | cold mode with neither `--from` nor `--repo` errors instead of hanging | pass |
| TC-DB6P | FR-18 | surfaces the child bootstrap's `bootstrapError` as a failure instead of waiting out the full timeout | pass |
| TC-OIC1 | FR-18 | returns a timeout error (not a hang) when bootstrap never reaches `ok:true` | pass |
| TC-KN8V | FR-18 | `--json` emits a single `{ ok: true, ... }` summary on stdout on success | pass |
| TC-B1CR | FR-18 | `--json` emits `{ ok: false, error }` on stdout before the process exits non-zero on failure | pass |
| TC-DR8O | FR-18 | rejects `gs://`/`s3://`-scheme values for `--from`/`--out` (local-paths-only invariant; `--repos` legitimately holds `https://`/`git@` git URLs and is exempt) | pass |
| TC-ZZMN | FR-18 | terminates its bootstrap child process (no orphan) after both success and timeout | pass |
| TC-GCGE | FR-18 | routes the bootstrap child's stdout/stderr into this process's own stderr (fd 2) instead of `stdio: 'ignore'` | pass |
| TC-W2FJ | FR-19 | submit_feedback records helped/notes/query/requestId/scores as an NDJSON feedback record and returns ok | pass |
| TC-ZOLQ | FR-19 | submit_feedback errors when helped is missing or not yes/partial/no | pass |
| TC-AYDQ | FR-19 | query MCP payload echoes the server requestId for feedback correlation | pass |
| TC-K557 | FR-19 | sets a top-level AGENT_INSTRUCTION nudge (not buried in notes) when the sampling gate passes | pass |
| TC-7NV4 | FR-19 | sets no AGENT_INSTRUCTION when KB_FEEDBACK_SAMPLE_RATE is unset or 0 (default off) | pass |
| TC-EHKV | FR-4 | query response echoes back the original query text | pass |
| TC-ZI7U | FR-19 | submit_feedback response echoes back the submitted query when provided, omits it when absent | pass |
| TC-CZ3E | FR-19 | submit_feedback response echoes the full recorded feedback (helped/notes/requestId/scores), not just query | pass |
| TC-ULOC | FR-19 | submit_feedback rejects a non-string requestId (no array batching) | pass |
| TC-KYRN | FR-20 | get_feedback_requests lists a pending entry queued by a sampled nudge, and submit_feedback resolves it | pass |
| TC-BZZH | FR-20 | submit_feedback with no requestId is valid general feedback and leaves the pending queue untouched | pass |
| TC-1SRC | FR-21 | sampled query with elicitFeedback accept records feedback via elicitation and skips AGENT_INSTRUCTION/pending | pass |
| TC-M9E1 | FR-21 | sampled query with elicitFeedback decline/cancel skips recording, AGENT_INSTRUCTION, and pending | pass |
| TC-PIQZ | FR-21 | sampled query with elicitFeedback unavailable falls back to AGENT_INSTRUCTION + pending | pass |
| TC-W21K | FR-21 | KB_MCP_ELICITATION defaults to true (unset/empty/`true`); only `false` opts out | pass |
| TC-MJBS | FR-22 | MCP POST without session (non-initialize) or GET without `mcp-session-id` returns 400 | pass |
| TC-S6SI | FR-23 | no elicitation capability declared: resolves unavailable without calling elicitInput or request | pass |
| TC-MGIV | FR-23 | client declares only url-mode capability (no form): resolves unavailable without asking | pass |
| TC-8HEN | FR-23 | client declares empty `elicitation: {}` (back-compat form-only): dispatches via the raw `server.request()` fallback, not `elicitInput` | pass |
| TC-BY0W | FR-23 | client declares explicit `elicitation: { form: {} }`: dispatches via `server.elicitInput()` | pass |
| TC-6RV1 | FR-23 | client responds accept with a valid helped value: resolves accepted with helped/notes | pass |
| TC-EYUX | FR-23 | client responds accept with a missing or invalid helped value: resolves unavailable | pass |
| TC-CXZ2 | FR-23 | client responds decline: resolves dismissed with action decline | pass |
| TC-AFVZ | FR-23 | client responds cancel: resolves dismissed with action cancel | pass |
| TC-U3IC | FR-23 | the client request rejects: resolves unavailable instead of throwing | pass |
| TC-0ARN | FR-24 | chat turn where the model returns no text | error event carrying empty_response, no answer event |
| TC-H88X | FR-24 | REST body for a failed synthesis | answerError present, answer null, sources retained |
| TC-86UB | FR-24 | MCP notes for a failed synthesis | leads with the outage, never "No synthesized answer was produced" |
| TC-EKVK | FR-24 | a best-effort stage degraded by an LLM error | note names the stage and kind; answer still returned |
| TC-10E6 | FR-24 | no answer and no failure | original evidence note unchanged, no answerError |
| TC-ZVKA | FR-24 | query when synthesis failed | answerError in payload, sources still cited |
| TC-RBLQ | FR-24 | sampling forced on and synthesis failed | no AGENT_INSTRUCTION and no feedback block |
| TC-SY60 | FR-6 | [NEW] REST `/v1/query` with `verbose: true` returns full evidence dump (`results`, `retrieval.detail`, GroupedSource facts) | pass |
| TC-BZDP | FR-25 | base create refuses the reserved `default` slug | pass |
| TC-J398 | FR-25 | base create requires at least one --git for a named base | pass |
| TC-1E89 | FR-25 | base create refuses a base that already exists | pass |
| TC-FI59 | FR-25 | base create builds a new named base from its repos | pass |
| TC-OJWT | FR-25 | base add-repo refuses a non-existent named base | pass |
| TC-PT5O | FR-25 | base add-repo allows adding a repo to the empty default base | pass |
| TC-VLX0 | FR-25 | base add-repo requires at least one --git | pass |
| TC-D8ZT | FR-25 | base list reports when no bases are initialized | pass |
| TC-QCCG | FR-25 | base list shows an initialized base | pass |
| TC-SU4B | FR-25 | base delete requires a base name | pass |
| TC-3T44 | FR-25 | base delete removes a base with --yes | pass |
| TC-WTZX | FR-25 | base help lists the subcommands | pass |
| TC-CESD | FR-26 | a /v1/chat turn writes a report whose turns hold the user message and assistant answer | pass |
| TC-8NCJ | FR-4 | query base argument resolves the named base via the registry instead of the session default | pass |
| TC-QCMR | FR-4 | query errors (not a 404) when base names a slug the registry can't resolve | pass |
| TC-01LO | FR-4 | query ignores a base argument when no registry is configured (single-base server) | pass |
| TC-CA0M | FR-6 | answer cites a file not in the sources | evidence downgrades from strong to weak, not just a note |
| TC-KG1I | FR-6 | every citation in the answer is grounded | evidence is left unchanged |
| TC-SVF8 | FR-6 | path-qualified citation's directory does not match a source with the same basename | reported as ungrounded |
| TC-QS05 | FR-6 | path-qualified citation matches a source path suffix | not reported as ungrounded |
| TC-Q6XO | FR-6 | bare filename citation with no directory component | still grounds by basename alone |

### Related docs

- [SERVER.md](SERVER.md)
- [FLY.md](../FLY.md) — Pages chatbot host (`kb-demo`)
- [demo/README.md](../../../demo/README.md) — browser client wait-for-bootstrap
- [CHAT_REPLY.md](../../kb-core/src/service/CHAT_REPLY.md) — shared answer/sources presentation
- [QUERY_INTERNALS.md](../../kb-core/src/core/QUERY_INTERNALS.md)
