/**
 * KB Run Telemetry
 *
 * Tracks per-stage timing, token usage, and estimated cost for every kb command.
 * Reports are written to ~/.kb/logs/<YYYY-MM-DD>.jsonl (NDJSON, one RunReport per line).
 * When --debug is passed, live stage summaries are printed to stderr.
 */

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

export interface RunReport {
  runId: string
  /** Chat session that spawned this run, if any. */
  sessionId?: string
  /** KB base name used for this run, if known. */
  base?: string
  command: string
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalEstimatedCostUsd: number
  stages: StageMetrics[]
  status: 'success' | 'error'
  errorMessage?: string
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

  constructor(
    readonly command: string,
    opts: { sessionId?: string; base?: string } = {}
  ) {
    this.runId = `run-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`
    this.startedAt = dayjs().toISOString()
    this.sessionId = opts.sessionId
    this.base = opts.base
  }

  /**
   * Record a completed stage. Call after the stage finishes.
   */
  addStage(metrics: StageMetrics): void {
    this.stages.push(metrics)
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
      command: this.command,
      startedAt: this.startedAt,
      finishedAt,
      totalDurationMs,
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd,
      stages: this.stages,
      status,
      errorMessage,
    }
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

/** Resolve the default logs directory: ~/.kb/logs */
export function defaultLogsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return path.join(home, '.kb', 'logs')
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
