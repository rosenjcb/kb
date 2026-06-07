`TokenCountingProvider` (src/core/telemetry.ts) wraps any `LLMProvider` implementation and
intercepts every `call()` response to accumulate `_inputTokens` and `_outputTokens`. It does not
alter the response — it passes through to `this.inner.call()` and adds the usage counts after the
fact. The `getAndReset()` method returns the running totals as `{inputTokens, outputTokens}` and
resets both counters to zero; this is called between init cycles so each cycle is measured
independently. The `peek()` method reads totals without resetting.

`RunCollector` (src/core/telemetry.ts) is the per-command accumulator. It is constructed with a
`command` string and optional `{sessionId, base}`; the constructor generates a `runId` of the form
`run-<timestamp>-<4chars>` and records `startedAt`. During a command run, callers use
`startStage(stage, provider, model)`, which captures `Date.now()` and returns a closer function.
When a stage finishes, the caller invokes the closer with `{inputTokens, outputTokens}`; the closer
computes `durationMs`, calls `estimateCost()` (via the `pricetoken` library), and calls `addStage()`
to push a `StageMetrics` record. Calling `finish(status)` aggregates all stages into a `RunReport`
with summed `totalInputTokens`, `totalOutputTokens`, and `totalEstimatedCostUsd`.

`ReportWriter` appends the completed `RunReport` as a single JSON line (NDJSON) to
`~/.kb/logs/YYYY-MM-DD.jsonl`. It creates the directory on first write and swallows all errors with
a stderr warning — it never throws, so a log failure cannot abort a kb command.
