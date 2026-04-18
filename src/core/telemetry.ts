/**
 * KB Run Telemetry
 *
 * Tracks per-stage timing, token usage, and estimated cost for every kb command.
 * Reports are written to ~/.kb/logs/<YYYY-MM-DD>.jsonl (NDJSON, one RunReport per line).
 * When --debug is passed, live stage summaries are printed to stderr.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'

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

// ─── Cost tables ──────────────────────────────────────────────────
// Rates in USD per 1M tokens. Stub = 0 until filled in.

interface PriceRow {
  inputPer1M: number
  outputPer1M: number
}

const PRICE_TABLE: Record<string, Record<string, PriceRow>> = {
  gemini: {
    'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
    'gemini-2.0-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
    'gemini-2.0-flash-lite': { inputPer1M: 0.0375, outputPer1M: 0.15 },
    'gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
    'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
    'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
    _default: { inputPer1M: 0.075, outputPer1M: 0.3 },
  },
  anthropic: {
    // Stubs — fill in when anthropic pricing is needed
    _default: { inputPer1M: 0, outputPer1M: 0 },
  },
  openai: {
    // Stubs — fill in when openai pricing is needed
    _default: { inputPer1M: 0, outputPer1M: 0 },
  },
  ollama: {
    _default: { inputPer1M: 0, outputPer1M: 0 },
  },
}

export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const providerTable = PRICE_TABLE[provider] ?? { _default: { inputPer1M: 0, outputPer1M: 0 } }
  const row = providerTable[model] ?? providerTable._default ?? { inputPer1M: 0, outputPer1M: 0 }
  return (inputTokens / 1_000_000) * row.inputPer1M + (outputTokens / 1_000_000) * row.outputPer1M
}

// ─── RunCollector ─────────────────────────────────────────────────

/**
 * Accumulates StageMetrics during a command run, then builds the final RunReport.
 */
export class RunCollector {
  private stages: StageMetrics[] = []
  private runId: string
  private startedAt: string
  private debug: boolean

  constructor(
    readonly command: string,
    opts: { debug?: boolean } = {}
  ) {
    this.runId = `run-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`
    this.startedAt = dayjs().toISOString()
    this.debug = opts.debug ?? false
  }

  /**
   * Record a completed stage. Call after the stage finishes.
   */
  addStage(metrics: StageMetrics): void {
    this.stages.push(metrics)
    if (this.debug) {
      const cost =
        metrics.estimatedCostUsd > 0 ? `$${metrics.estimatedCostUsd.toFixed(5)}` : '$0.00000'
      process.stderr.write(
        `[kb:debug] ${metrics.stage.padEnd(24)} ${String(metrics.durationMs).padStart(6)}ms  in=${metrics.inputTokens} out=${metrics.outputTokens}  ${cost}  ${metrics.provider}/${metrics.model}\n`
      )
    }
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

  finish(status: 'success' | 'error', errorMessage?: string): RunReport {
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

    if (this.debug) {
      process.stderr.write(
        `[kb:debug] ─────────────────────────────────────────────────────────────\n[kb:debug] Total: ${totalDurationMs}ms  in=${totalInputTokens} out=${totalOutputTokens}  $${totalEstimatedCostUsd.toFixed(5)}\n`
      )
    }

    return {
      runId: this.runId,
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
