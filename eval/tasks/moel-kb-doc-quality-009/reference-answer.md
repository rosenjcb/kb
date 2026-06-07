`RunCollector` (src/core/telemetry.ts) is kb's per-command telemetry accumulator. It is
instantiated with a `command` string and optional `{sessionId, base}` metadata; on construction,
it generates a unique `runId` of the form `run-<timestamp>-<4randomChars>` and records
`startedAt` as the current ISO timestamp. The lifecycle proceeds in three phases: callers invoke
`startStage(stage, provider, model)` at the beginning of each named operation (e.g., 'code-index',
'document-facts'), which captures `Date.now()` and returns a closer function; when the stage
completes, the caller invokes that closer with `{inputTokens, outputTokens}`, which computes
`durationMs`, estimates cost via the `pricetoken` library, and calls the internal `addStage()`
method to append a `StageMetrics` record. Finally, `finish(status)` aggregates all accumulated
stages into a `RunReport` containing `runId`, `command`, `startedAt`, `finishedAt`,
`totalDurationMs`, `totalInputTokens`, `totalOutputTokens`, `totalEstimatedCostUsd`, a `stages`
array, and `status`. The completed `RunReport` is then passed to `ReportWriter`, which appends it
as a single NDJSON line to `~/.kb/logs/YYYY-MM-DD.jsonl`, creating the log directory if needed
and silently swallowing any write errors to prevent telemetry failures from aborting commands.
