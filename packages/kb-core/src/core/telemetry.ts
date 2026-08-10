/**
 * KB Run Telemetry
 *
 * Tracks per-stage timing, token usage, and estimated cost for every kb command.
 * Reports are written to ~/.kb/logs/<YYYY-MM-DD>.jsonl (NDJSON, one RunReport per line).
 * When --debug is passed, live stage summaries are printed to stderr.
 */

import type { EvidenceLabel } from './evidence-label'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import { calculateModelCost } from 'pricetoken'

// ─── Types ────────────────────────────────────────────────────────

export interface StageMetrics {
  stage: string
  startedAt: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  provider: string
  model: string
}

/**
 * Structured per-hop record of a single `kb query` retrieval loop, persisted so the eval
 * harness can reconstruct the *timeline* of a run (which passes ran, how the frontier grew,
 * and which facts the curator kicked out) rather than only the end totals. Everything here is
 * a distillation of the in-memory `retrieval` object the loop already produces — it is written
 * once per query and never fed back into synthesis.
 */
export interface QueryCurationTrace {
  /** Facts the curator inspected (auto-kept + judged). */
  evaluated?: number
  /** Facts that survived curation and reached synthesis. */
  kept: number
  /** Facts hard-dropped as off-topic. */
  dropped: number
  /** Bounded re-discovery gap queries issued to refill after drops. */
  requeried: number
  /** Judge rounds run (initial verdict + re-judges). */
  rounds: number
  /** Curator's own sufficiency self-assessment, when reported. */
  sufficient?: boolean
  /** Ids of the facts the curator kicked out (empty when none / not surfaced). */
  droppedFactIds: string[]
}

export interface QueryRetrievalTrace {
  method?: string
  /** Whole documents in the fused result. */
  documents?: number
  /** Exported code symbols in the fused result. */
  symbols?: number
  /** Curated facts in the fused result. */
  facts?: number
  /** Units pulled in by the depth-1 doc↔symbol hop. */
  hops?: number
  /** Sub-queries fanned out and re-fused (deep mode). */
  expanded?: number
  /** Per-pass checkpoint decisions (status + evidence label). */
  checkpoints?: Array<{
    stage?: string
    status?: string
    nextAction?: string
    evidence?: EvidenceLabel
  }>
  /** Post-retrieval curator audit, when curation ran. */
  curation?: QueryCurationTrace
}

export interface RunReport {
  runId: string
  /** Chat session that spawned this run, if any. */
  sessionId?: string
  /** KB base name used for this run, if known. */
  base?: string
  /** Server host:port the run executed against (e.g. localhost:38117). */
  host?: string
  command: string
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalEstimatedCostUsd: number
  stages: StageMetrics[]
  /** Per-hop retrieval trace for `kb query` runs (absent for other commands). */
  retrieval?: QueryRetrievalTrace
  status: 'success' | 'error'
  errorMessage?: string
}

/** Strip legacy `server.` prefix from stored command names. */
export function normalizeRunCommand(command: string): string {
  return command.startsWith('server.') ? command.slice('server.'.length) : command
}

/** Display target for `kb logs list` — `${host}/${base}` when both are known. */
export function formatLogTarget(host?: string, base?: string): string {
  if (!host && !base) return '-'
  if (host && base) return `${host}/${base}`
  if (host) return host
  return `-/${base}`
}

export function estimateCost(
  _provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  if (inputTokens === 0 && outputTokens === 0) return 0
  try {
    return calculateModelCost(model, inputTokens, outputTokens).totalCost
  } catch {
    return 0
  }
}

// ─── RunCollector ─────────────────────────────────────────────────

/**
 * Accumulates StageMetrics during a command run, then builds the final RunReport.
 */
export class RunCollector {
  private stages: StageMetrics[] = []
  private runId: string
  private startedAt: string
  private sessionId?: string
  private base?: string
  private host?: string
  private retrieval?: QueryRetrievalTrace

  constructor(
    readonly command: string,
    opts: { sessionId?: string; base?: string; host?: string } = {}
  ) {
    this.runId = `run-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`
    this.startedAt = dayjs().toISOString()
    this.sessionId = opts.sessionId
    this.base = opts.base
    this.host = opts.host
  }

  /**
   * Record a completed stage. Call after the stage finishes.
   */
  addStage(metrics: StageMetrics): void {
    this.stages.push(metrics)
  }

  /**
   * Attach the per-hop retrieval trace for a `kb query` run. Called once after the retrieval
   * loop finishes; overwrites any prior trace. No-op semantics if never called (report omits it).
   */
  setRetrievalTrace(trace: QueryRetrievalTrace): void {
    this.retrieval = trace
  }

  /**
   * Start timing a stage. Returns a function to stop and record it.
   */
  startStage(
    stage: string,
    provider: string,
    model: string
  ): (tokens: { inputTokens: number; outputTokens: number }) => void {
    const startMs = Date.now()
    const startedAt = dayjs().toISOString()
    return tokens => {
      const durationMs = Date.now() - startMs
      this.addStage({
        stage,
        startedAt,
        durationMs,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        estimatedCostUsd: estimateCost(provider, model, tokens.inputTokens, tokens.outputTokens),
        provider,
        model,
      })
    }
  }

  finish(status: 'success' | 'error', errorMessage?: string, base?: string): RunReport {
    if (base) this.base = base
    const finishedAt = dayjs().toISOString()
    const totalDurationMs = Date.now() - dayjs(this.startedAt).valueOf()

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalEstimatedCostUsd = 0

    for (const s of this.stages) {
      totalInputTokens += s.inputTokens
      totalOutputTokens += s.outputTokens
      totalEstimatedCostUsd += s.estimatedCostUsd
    }

    return {
      runId: this.runId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.base ? { base: this.base } : {}),
      ...(this.host ? { host: this.host } : {}),
      command: normalizeRunCommand(this.command),
      startedAt: this.startedAt,
      finishedAt,
      totalDurationMs,
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd,
      stages: this.stages,
      ...(this.retrieval ? { retrieval: this.retrieval } : {}),
      status,
      errorMessage,
    }
  }
}

/**
 * Distill the in-memory retrieval object produced by the facts loop into the flat
 * {@link QueryRetrievalTrace} persisted on the run report. Pure and defensive: unknown shapes
 * degrade to empty/absent fields rather than throwing, so telemetry never blocks a query.
 *
 * `detail` carries the hybrid retrieval counts as a `;`-joined string
 * (`hybrid:docs=12,symbols=8,facts=0,hops=4;expanded:3;curated:kept=18,dropped=6,requeried=0,rounds=1`),
 * and `curation` is the raw curator audit. This re-lifts both into structured fields.
 */
export function summarizeQueryRetrievalTrace(retrieval: {
  method?: string
  detail?: string
  checkpoints?: Array<{ stage?: string; status?: string; nextAction?: string; evidence?: EvidenceLabel }>
  curation?: {
    evaluated?: number
    dropped?: unknown[]
    added?: number
    requeried?: string[]
    rounds?: number
    sufficient?: boolean
  }
}): QueryRetrievalTrace {
  const detail = typeof retrieval.detail === 'string' ? retrieval.detail : ''
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(detail)
    return m ? Number(m[1]) : undefined
  }
  const curatedMatch =
    /curated:kept=(\d+),dropped=(\d+),requeried=(\d+),rounds=(\d+)/.exec(detail)

  const rawCuration = retrieval.curation
  let curation: QueryCurationTrace | undefined
  if (rawCuration || curatedMatch) {
    const droppedList = Array.isArray(rawCuration?.dropped) ? rawCuration.dropped : []
    const droppedFactIds = droppedList
      .map(d =>
        d && typeof d === 'object' && 'id' in d ? String((d as { id: unknown }).id) : null
      )
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    // kept: prefer the audited count from the detail string; else derive from the raw record
    // (evaluated − dropped + re-discovery adds), clamped at 0.
    const derivedKept = Math.max(
      0,
      (typeof rawCuration?.evaluated === 'number' ? rawCuration.evaluated : droppedList.length) -
        droppedList.length +
        (typeof rawCuration?.added === 'number' ? rawCuration.added : 0)
    )
    curation = {
      ...(typeof rawCuration?.evaluated === 'number' ? { evaluated: rawCuration.evaluated } : {}),
      kept: curatedMatch ? Number(curatedMatch[1]) : derivedKept,
      dropped: curatedMatch ? Number(curatedMatch[2]) : droppedList.length,
      requeried: curatedMatch
        ? Number(curatedMatch[3])
        : Array.isArray(rawCuration?.requeried)
          ? rawCuration.requeried.length
          : 0,
      rounds: curatedMatch ? Number(curatedMatch[4]) : (rawCuration?.rounds ?? 0),
      ...(typeof rawCuration?.sufficient === 'boolean'
        ? { sufficient: rawCuration.sufficient }
        : {}),
      droppedFactIds,
    }
  }

  return {
    ...(retrieval.method ? { method: retrieval.method } : {}),
    ...(num(/(?:^|[;:])docs=(\d+)/) !== undefined ? { documents: num(/(?:^|[;:])docs=(\d+)/) } : {}),
    ...(num(/(?:^|,)symbols=(\d+)/) !== undefined ? { symbols: num(/(?:^|,)symbols=(\d+)/) } : {}),
    ...(num(/(?:^|,)facts=(\d+)/) !== undefined ? { facts: num(/(?:^|,)facts=(\d+)/) } : {}),
    ...(num(/(?:^|,)hops=(\d+)/) !== undefined ? { hops: num(/(?:^|,)hops=(\d+)/) } : {}),
    ...(num(/(?:^|;)expanded:(\d+)/) !== undefined ? { expanded: num(/(?:^|;)expanded:(\d+)/) } : {}),
    ...(Array.isArray(retrieval.checkpoints) && retrieval.checkpoints.length > 0
      ? { checkpoints: retrieval.checkpoints }
      : {}),
    ...(curation ? { curation } : {}),
  }
}

// ─── ReportWriter ─────────────────────────────────────────────────

/**
 * Appends a RunReport to ~/.kb/logs/<YYYY-MM-DD>.jsonl.
 * Creates the directory on first write. Never throws — logs a warning on failure.
 */
export class ReportWriter {
  constructor(private logsDir: string) {}

  async append(report: RunReport): Promise<void> {
    try {
      await mkdir(this.logsDir, { recursive: true })
      const date = dayjs(report.startedAt).format('YYYY-MM-DD')
      const file = path.join(this.logsDir, `${date}.jsonl`)
      await appendFile(file, `${JSON.stringify(report)}\n`, 'utf-8')
    } catch (err) {
      process.stderr.write(
        `[kb] Warning: could not write run report: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }
}

/** Resolve the default logs directory. Prefers KB_HOME when set (important for server/container use). */
export function defaultLogsDir(): string {
  const kbHome = process.env.KB_HOME?.trim()
  if (kbHome) return path.join(kbHome, 'logs')
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return path.join(home, '.kb', 'logs')
}

/**
 * Resolve the default query-trace directory (opt-in `kb query --trace` dumps). Sibling of the
 * logs dir, KB_HOME-aware for server/container use.
 */
export function defaultTracesDir(): string {
  const kbHome = process.env.KB_HOME?.trim()
  if (kbHome) return path.join(kbHome, 'traces')
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return path.join(home, '.kb', 'traces')
}

// ─── Trajectory Tracking ──────────────────────────────────────────

export interface TrajectoryStep {
  stepIndex: number
  timestampMs: number
  toolName: string
  arguments: Record<string, unknown>
  freshTokens: number
  cachedTokens: number
  outputTokens: number
}

export interface TrajectoryFile {
  taskId: string
  condition: 'N' | 'K' | 'O'
  totalSteps: number
  elapsedMs: number
  steps: TrajectoryStep[]
}

export class TrajectoryCollector {
  private steps: TrajectoryStep[] = []
  private startMs: number

  constructor(
    private taskId: string,
    private condition: 'N' | 'K' | 'O'
  ) {
    this.startMs = Date.now()
  }

  record_step(
    toolName: string,
    args: Record<string, unknown>,
    tokens?: { fresh?: number; cached?: number; output?: number }
  ): void {
    this.steps.push({
      stepIndex: this.steps.length,
      timestampMs: Date.now() - this.startMs,
      toolName,
      arguments: args,
      freshTokens: tokens?.fresh ?? 0,
      cachedTokens: tokens?.cached ?? 0,
      outputTokens: tokens?.output ?? 0,
    })
  }

  compileTrajectory(): TrajectoryFile {
    return {
      taskId: this.taskId,
      condition: this.condition,
      totalSteps: this.steps.length,
      elapsedMs: Date.now() - this.startMs,
      steps: this.steps,
    }
  }

  async writeTrajectory(runDir: string): Promise<void> {
    await mkdir(runDir, { recursive: true })
    await writeFile(
      path.join(runDir, `trajectory_${this.condition}.json`),
      JSON.stringify(this.compileTrajectory(), null, 2),
      'utf-8'
    )
  }
}

// ─── TokenCountingProvider ────────────────────────────────────────

import type { LLMCallParams, LLMProvider, LLMResponse, LLMStreamChunk } from './types'

/**
 * Wraps any LLMProvider and accumulates token usage across all .call() invocations.
 * Use getAndReset() to read the total and reset the counter (e.g. between init cycles).
 */
export class TokenCountingProvider implements LLMProvider {
  private _inputTokens = 0
  private _outputTokens = 0

  constructor(private inner: LLMProvider) {}

  get name(): string {
    return this.inner.name
  }
  get model(): string {
    return this.inner.model
  }
  get supportsStreaming(): boolean {
    return this.inner.supportsStreaming
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const response = await this.inner.call(params)
    this._inputTokens += response.usage.inputTokens
    this._outputTokens += response.usage.outputTokens
    return response
  }

  async *callStream(params: LLMCallParams): AsyncGenerator<LLMStreamChunk> {
    if (this.inner.callStream) {
      yield* this.inner.callStream(params)
    }
  }

  /** Return accumulated totals and reset counters. */
  getAndReset(): { inputTokens: number; outputTokens: number } {
    const counts = { inputTokens: this._inputTokens, outputTokens: this._outputTokens }
    this._inputTokens = 0
    this._outputTokens = 0
    return counts
  }

  /** Peek at current totals without resetting. */
  peek(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this._inputTokens, outputTokens: this._outputTokens }
  }
}
