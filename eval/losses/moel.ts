/**
 * Multi-Objective Exploration Loss (MOEL) Aggregator
 *
 * Combines the three loss components into a single scalar:
 *
 *   L_MOEL = wC * L_correctness + wT * L_trajectory + wR * L_resource
 *
 * where L_correctness = mu * L_AST + (1 - mu) * L_jury
 *
 * Default weights: wC=0.5, wT=0.3, wR=0.2, mu=0.6
 * Weights are loaded from eval/config/moel-weights.json at runtime;
 * the defaults above are fallbacks when the file is absent.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WEIGHT_SUM_EPSILON = 1e-6

export interface MoelComponents {
  lAst: number        // [0, 1] Jaccard structural distance (TICKET-002)
  lJury: number       // [0, 1] LLM jury semantic loss (TICKET-003)
  lTrajectory: number // [0, 1] trajectory inefficiency loss (TICKET-004)
  lResource: number   // [0, 1] resource consumption loss (from ResourceLossResult.loss)
}

export interface MoelWeights {
  wC: number  // correctness weight — default 0.5
  wT: number  // trajectory weight — default 0.3
  wR: number  // resource weight   — default 0.2
  mu: number  // AST/jury balance [0, 1] — default 0.6
}

export interface MoelResult {
  lMoel: number
  lCorrectness: number
  lAst: number
  lJury: number
  lTrajectory: number
  lResource: number
  weights: MoelWeights
  taskId: string
  condition: string
}

export interface ComparisonReport {
  conditions: string[]
  pairwise: Record<string, number>  // e.g. { "N-K": 0.23 } — positive confirms hypothesis
  hypothesisConfirmed: boolean      // true when L_MOEL(N) > L_MOEL(K)
}

const DEFAULT_WEIGHTS: MoelWeights = { wC: 0.5, wT: 0.3, wR: 0.2, mu: 0.6 }

/** Load weights from eval/config/moel-weights.json, falling back to defaults. */
export async function loadDefaultWeights(): Promise<MoelWeights> {
  try {
    const filePath = path.join(__dirname, '..', 'config', 'moel-weights.json')
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as MoelWeights
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

function validateComponents(c: MoelComponents): void {
  for (const [key, val] of Object.entries(c) as [keyof MoelComponents, number][]) {
    if (val < 0 || val > 1) {
      throw new Error(`MoelComponents.${key} must be in [0, 1]; got ${val}`)
    }
  }
}

function validateWeights(w: MoelWeights): void {
  const sum = w.wC + w.wT + w.wR
  if (Math.abs(sum - 1.0) > WEIGHT_SUM_EPSILON) {
    throw new Error(
      `MoelWeights sum must equal 1.0 within ${WEIGHT_SUM_EPSILON}; got ${sum.toFixed(10)} (wC=${w.wC}, wT=${w.wT}, wR=${w.wR})`
    )
  }
  for (const [key, val] of Object.entries(w) as [keyof MoelWeights, number][]) {
    if (val < 0 || val > 1) {
      throw new Error(`MoelWeights.${key} must be in [0, 1]; got ${val}`)
    }
  }
}

/**
 * Aggregate the three loss components into a single MOEL score.
 *
 * @param components - the four raw loss values
 * @param weights    - mixing weights (must sum to 1 within WEIGHT_SUM_EPSILON)
 * @param taskId     - task identifier for the result record
 * @param condition  - evaluation condition ("N", "K", or "O")
 */
export function computeMoel(
  components: MoelComponents,
  weights: MoelWeights,
  taskId: string,
  condition: string
): MoelResult {
  validateComponents(components)
  validateWeights(weights)

  const lCorrectness = weights.mu * components.lAst + (1 - weights.mu) * components.lJury
  const lMoel =
    weights.wC * lCorrectness +
    weights.wT * components.lTrajectory +
    weights.wR * components.lResource

  return {
    lMoel,
    lCorrectness,
    lAst: components.lAst,
    lJury: components.lJury,
    lTrajectory: components.lTrajectory,
    lResource: components.lResource,
    weights,
    taskId,
    condition,
  }
}

/**
 * Compare MOEL results across conditions for a single task.
 *
 * The primary hypothesis check: pairwise["N-K"] > 0 means Condition N (raw filesystem)
 * has higher loss than Condition K (kb-enabled), confirming kb's value.
 */
export function compareConditions(results: Record<string, MoelResult>): ComparisonReport {
  const conditions = Object.keys(results)
  const pairwise: Record<string, number> = {}

  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      const a = conditions[i]
      const b = conditions[j]
      pairwise[`${a}-${b}`] = results[a].lMoel - results[b].lMoel
    }
  }

  const hypothesisConfirmed =
    'N' in results && 'K' in results ? results.N.lMoel > results.K.lMoel : false

  return { conditions, pairwise, hypothesisConfirmed }
}
