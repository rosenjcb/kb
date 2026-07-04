/**
 * Resource Consumption Loss (L_resource)
 *
 * Measures a run's weighted token footprint against a task budget.
 * Cached reads are weighted at delta (default 0.1, matching Anthropic's
 * prompt caching discount ratio); output tokens at gamma (default 1.0).
 *
 * NOTE: The existing StageMetrics / TokenCountingProvider in src/core/telemetry.ts
 * track only an undifferentiated inputTokens total — no fresh/cached split.
 * The fresh/cached split lives exclusively in TrajectoryStep fields populated
 * by TrajectoryCollector.record_step(). Always sum from trajectory.steps, never
 * from RunReport or StageMetrics.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrajectoryFile } from '@kb/core/core/telemetry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ResourceLossResult {
  loss: number          // in [0, 1]
  freshTokens: number   // sum of step.freshTokens across all steps
  cachedTokens: number  // sum of step.cachedTokens across all steps
  outputTokens: number  // sum of step.outputTokens across all steps
  weightedTotal: number // C_fresh + delta*C_cached + gamma*C_output
  budget: number        // the budget used for normalization
}

interface ProviderCosts {
  delta: number
  gamma: number
}

const DEFAULT_COSTS: ProviderCosts = { delta: 0.1, gamma: 1.0 }
const DEFAULT_BUDGET = 250_000

/** Load cost ratios from eval/config/provider-costs.json, falling back to defaults. */
export async function loadProviderCosts(): Promise<ProviderCosts> {
  try {
    const filePath = path.join(__dirname, '..', 'config', 'provider-costs.json')
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as ProviderCosts
  } catch {
    return DEFAULT_COSTS
  }
}

/**
 * Compute the normalized resource consumption loss.
 *
 * @param trajectory - compiled trajectory from TrajectoryCollector
 * @param budget     - token budget for this task (default 250_000)
 * @param delta      - cached-token discount factor (default 0.1)
 * @param gamma      - output-token weight (default 1.0)
 */
export function computeResourceLoss(
  trajectory: TrajectoryFile,
  budget = DEFAULT_BUDGET,
  delta = DEFAULT_COSTS.delta,
  gamma = DEFAULT_COSTS.gamma
): ResourceLossResult {
  let fresh = 0
  let cached = 0
  let output = 0

  for (const step of trajectory.steps) {
    fresh += step.freshTokens
    cached += step.cachedTokens
    output += step.outputTokens
  }

  const weightedTotal = fresh + delta * cached + gamma * output
  const loss = Math.min(weightedTotal / budget, 1.0)

  return { loss, freshTokens: fresh, cachedTokens: cached, outputTokens: output, weightedTotal, budget }
}
