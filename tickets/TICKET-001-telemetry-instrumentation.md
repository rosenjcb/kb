# TICKET-001: Extend Telemetry with Trajectory Tracking

**Status:** Open  
**Priority:** P0 — Foundational (all other tickets depend on this)  
**Language:** TypeScript  
**Labels:** infrastructure, evaluation

## Context

`src/core/telemetry.ts` already exports the following types and classes (all lines
referenced are in that file as it exists now):

| Export | Kind | Location |
|---|---|---|
| `StageMetrics` | `interface` | line 16 |
| `RunReport` | `interface` | line 27 |
| `estimateCost(provider, model, inputTokens, outputTokens): number` | function | line 45 |
| `RunCollector` | `class` | line 64 |
| `ReportWriter` | `class` | line 152 |
| `defaultLogsDir(): string` | function | line 170 |
| `TokenCountingProvider` | `class` | line 183 |

`RunCollector` accumulates `StageMetrics[]` via `addStage(metrics: StageMetrics): void`
and `startStage(stage, provider, model)` (returns a closer callback). It builds a
`RunReport` on `finish(status, errorMessage?, base?)`.

`ReportWriter.append(report: RunReport)` writes NDJSON to
`~/.kb/logs/<YYYY-MM-DD>.jsonl` (the logs directory is resolved by `defaultLogsDir()`
and passed at construction time).

**`TokenCountingProvider` does NOT split fresh vs cached tokens.** It only tracks two
aggregated counters (`_inputTokens: number`, `_outputTokens: number`), both incremented
from `response.usage.inputTokens` / `response.usage.outputTokens`. It exposes:
- `peek(): { inputTokens: number; outputTokens: number }` — read without resetting
- `getAndReset(): { inputTokens: number; outputTokens: number }` — read and zero out

There is no `cachedTokens` or `freshTokens` field anywhere in the existing provider.
The `TrajectoryCollector` spec that mentions `fresh` and `cached` token split must
treat `cached` as caller-supplied (the evaluation harness reads it from a lower-level
API response) and default missing fields to `0` as described below.

The `eval-run.mjs` script writes its primary output artifact to
`path.join(runDir, 'artifact.json')` (line 1208, falling back from `args.outFile`),
where `runDir` is `path.join(os.homedir(), '.kb', 'evaluations', runName)` (lines
86–88, 726). The run name is computed by `allocateRunName(repoLeaf)` as
`<repoLeaf>-YYYY-MM-DD-HHmm` (line 129). Trajectory files should be written into
the same `runDir`, not inside the `<repo-name>/` sub-directory.

There is an existing test file at `tests/core/telemetry.test.ts`. It imports from
`../../src/core/telemetry` and already contains `describe` blocks for `estimateCost`,
`RunCollector`, `TokenCountingProvider`, and `ReportWriter`. A new `describe`
block for `TrajectoryCollector` should be appended to that file (do not create a
new file).

## Objective

Extend the existing telemetry layer with a `TrajectoryCollector` class that records
per-step tool call data alongside existing stage metrics. The new class should integrate
cleanly with `RunCollector` without breaking any existing telemetry usage.

## Acceptance Criteria

- [ ] `TrajectoryStep` interface is exported from `src/core/telemetry.ts` with exactly
  these fields:
  ```ts
  export interface TrajectoryStep {
    stepIndex: number          // 0-based, incremented on each record_step call
    timestampMs: number        // Date.now() minus the constructor's Date.now() snapshot
    toolName: string
    arguments: Record<string, unknown>
    freshTokens: number        // defaults to 0 if not supplied
    cachedTokens: number       // defaults to 0 if not supplied
    outputTokens: number       // defaults to 0 if not supplied
  }
  ```

- [ ] `TrajectoryFile` interface is exported from `src/core/telemetry.ts` with exactly
  these fields:
  ```ts
  export interface TrajectoryFile {
    taskId: string
    condition: 'N' | 'K' | 'O'
    totalSteps: number
    elapsedMs: number
    steps: TrajectoryStep[]
  }
  ```

- [ ] `TrajectoryCollector` class is exported from `src/core/telemetry.ts`. Add it
  after the `ReportWriter` / `defaultLogsDir` block and before the
  `TokenCountingProvider` section (i.e. insert between line 173 and the import of
  `LLMCallParams` at line 177). Constructor signature:
  ```ts
  constructor(taskId: string, condition: 'N' | 'K' | 'O')
  ```

- [ ] `record_step(toolName: string, args: Record<string, unknown>, tokens?: { fresh?: number; cached?: number; output?: number }): void`
  appends a `TrajectoryStep`. All three token sub-fields default to `0` when absent
  or `undefined`.

- [ ] `compileTrajectory(): TrajectoryFile` returns the accumulated object. `elapsedMs`
  is `Date.now()` at call time minus the timestamp captured in the constructor.
  `totalSteps` equals `steps.length`.

- [ ] `writeTrajectory(runDir: string): Promise<void>` writes the compiled trajectory
  to `path.join(runDir, `trajectory_${this.condition}.json`)` using
  `node:fs/promises` `writeFile` with `JSON.stringify(…, null, 2)`. It must call
  `mkdir(runDir, { recursive: true })` before writing (same pattern as
  `ReportWriter.append`). The resulting path for a condition-`N` run named
  `raylib-2026-06-06-1430` would be:
  `~/.kb/evaluations/raylib-2026-06-06-1430/trajectory_N.json`

- [ ] `TrajectoryFile` serializes cleanly to JSON — no `Date` objects, `Map`,
  `Set`, `undefined` values, or circular references.

- [ ] `TokenCountingProvider` is left completely unchanged. The evaluation harness
  that calls `record_step` is responsible for obtaining the `fresh`/`cached`/`output`
  token split from its own API response metadata and passing it in.

- [ ] New `describe('TrajectoryCollector', …)` block added at the end of
  `tests/core/telemetry.test.ts` (after the existing `ReportWriter` block, line 320).
  Add `TrajectoryCollector` (and `TrajectoryFile`, `TrajectoryStep`) to the named
  import at line 8. Required test cases:
  - **empty trajectory** — `compileTrajectory()` on a fresh collector: `totalSteps`
    is `0`, `steps` is `[]`, `elapsedMs` is a non-negative number.
  - **single step** — one `record_step` call: `stepIndex` is `0`, `timestampMs` is
    a non-negative number, `toolName` and `arguments` match what was passed.
  - **duplicate tool calls** — two `record_step` calls with the same `toolName`:
    both appear in `steps`, `stepIndex` values are `0` and `1` respectively.
  - **zero-token step** — `record_step` called without a `tokens` argument: all
    three token fields (`freshTokens`, `cachedTokens`, `outputTokens`) are `0`.
  - **JSON round-trip** — `JSON.parse(JSON.stringify(compileTrajectory()))` deep-equals
    `compileTrajectory()` (no non-serializable values survive the round-trip).
  - **writeTrajectory** — write to a `mkdtemp` temp dir and confirm the file exists
    at `path.join(tmpDir, 'trajectory_K.json')` and parses back to a valid
    `TrajectoryFile`.

## Implementation Notes

Do not replace or modify `RunCollector`, `StageMetrics`, `RunReport`, `ReportWriter`,
`defaultLogsDir`, or `TokenCountingProvider` — they are used by all existing `kb`
commands and their tests are already passing.

`TrajectoryCollector` is a new, additive class used only by the MOEL evaluation
harness. It does not need to be wired into `RunCollector` or `ReportWriter`.

The `condition` field must be one of `"N"`, `"K"`, or `"O"` as defined in PLAN.md.
Use a TypeScript union literal type (`'N' | 'K' | 'O'`) so callers get a compile-time
error if they pass an unknown condition string.

Keep `arguments` as a plain `Record<string, unknown>` — the evaluation harness
normalizes it for redundancy detection in TICKET-004 and must receive the raw object.

Use `node:fs/promises` imports already present in the file (`appendFile`, `mkdir` are
imported at line 9); add `writeFile` to the same import statement.

## Files to Modify

- `src/core/telemetry.ts` — add `TrajectoryStep`, `TrajectoryFile`, `TrajectoryCollector`
  between `defaultLogsDir` (line 173) and the `LLMCallParams` import (line 177).
  Add `writeFile` to the existing `import { appendFile, mkdir } from 'node:fs/promises'`
  at line 9.
- `tests/core/telemetry.test.ts` — extend the named import at line 8 and append a
  new `describe('TrajectoryCollector', …)` block after line 320.

## Dependencies

None — this is the foundation.

## Feeds Into

TICKET-002, TICKET-003, TICKET-004, TICKET-005, TICKET-009
