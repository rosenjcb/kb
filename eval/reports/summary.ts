/**
 * MOEL summary reporter.
 *
 * Reads moel_results.json from a run directory and produces:
 * - A markdown comparison table
 * - A JSON summary object
 *
 * Usage:
 *   import { buildSummaryMarkdown, buildSummaryJson } from './summary.js'
 */

export interface TaskConditionResult {
  lMoel: number | null
  terminated: boolean
  terminatedBy: string | null
}

export interface TaskSummaryRow {
  taskId: string
  conditions: Record<string, TaskConditionResult>
  nKDelta: number | null
  hypothesisConfirmed: boolean | null
}

export interface MoelSummary {
  runName: string
  suite: string
  hypothesisConfirmed: boolean
  tasks: TaskSummaryRow[]
  aggregate: {
    meanLMoelByCondition: Record<string, number | null>
    nKDelta: number | null
  }
}

function fmtLoss(v: number | null): string {
  if (v == null) return '  -  '
  return v.toFixed(3)
}

function fmtDelta(v: number | null): string {
  if (v == null) return '  -  '
  return (v >= 0 ? '+' : '') + v.toFixed(3)
}

/** Build a markdown comparison table from moel_results.json content. */
export function buildSummaryMarkdown(moelResults: Record<string, unknown>): string {
  const tasks = (moelResults.tasks ?? []) as Array<Record<string, unknown>>
  const conditions = (moelResults.conditions ?? ['N', 'K', 'O']) as string[]
  const runName = String(moelResults.runName ?? 'unknown')
  const suite = String(moelResults.suite ?? 'unknown')

  const header = [
    `# MOEL Summary — ${runName}`,
    `Suite: \`${suite}\``,
    '',
    `| ${'Task ID'.padEnd(36)} | ${conditions.map(c => `${c} L_MOEL`.padStart(8)).join(' | ')} | N-K Delta | Hypothesis |`,
    `| ${'-'.repeat(36)} | ${conditions.map(() => '-'.repeat(8)).join(' | ')} | --------- | ---------- |`,
  ]

  const rows: string[] = []
  let sumN = 0
  let countN = 0
  let sumK = 0
  let countK = 0
  let hypothesisConfirmed = true

  for (const taskEntry of tasks) {
    // taskEntry is a map of condition → result
    const condResults = taskEntry as Record<string, { loss?: { lMoel?: number }, terminated?: boolean, terminatedBy?: string, taskId?: string }>
    const firstCond = conditions[0]
    const taskId = condResults[firstCond]?.taskId ?? 'unknown'

    const lossValues: Record<string, number | null> = {}
    for (const cond of conditions) {
      lossValues[cond] = condResults[cond]?.loss?.lMoel ?? null
    }

    const n = lossValues.N
    const k = lossValues.K
    const delta = n != null && k != null ? n - k : null
    const condHypothesis = n != null && k != null ? n > k : null

    if (condHypothesis === false) hypothesisConfirmed = false

    if (n != null) { sumN += n; countN++ }
    if (k != null) { sumK += k; countK++ }

    const lossCells = conditions.map(c => fmtLoss(lossValues[c]).padStart(8))
    const hypothesisCell = condHypothesis == null ? '  -  ' : condHypothesis ? '✓' : '✗'

    rows.push(
      `| ${taskId.slice(0, 36).padEnd(36)} | ${lossCells.join(' | ')} | ${fmtDelta(delta).padStart(9)} | ${hypothesisCell.padStart(10)} |`
    )
  }

  const meanN = countN > 0 ? sumN / countN : null
  const meanK = countK > 0 ? sumK / countK : null
  const aggDelta = meanN != null && meanK != null ? meanN - meanK : null

  const aggLossCells = conditions.map(c => {
    if (c === 'N') return fmtLoss(meanN).padStart(8)
    if (c === 'K') return fmtLoss(meanK).padStart(8)
    return '  -  '.padStart(8)
  })

  const aggRow = `| ${'**Aggregate**'.padEnd(36)} | ${aggLossCells.join(' | ')} | ${fmtDelta(aggDelta).padStart(9)} | ${(hypothesisConfirmed ? '✓' : '✗').padStart(10)} |`

  return [
    ...header,
    ...rows,
    `| ${'-'.repeat(36)} | ${conditions.map(() => '-'.repeat(8)).join(' | ')} | --------- | ---------- |`,
    aggRow,
    '',
    `**hypothesisConfirmed:** ${hypothesisConfirmed} (L_MOEL(N) > L_MOEL(K))`,
  ].join('\n')
}

/** Build a structured JSON summary from moel_results.json content. */
export function buildSummaryJson(moelResults: Record<string, unknown>): MoelSummary {
  const tasks = (moelResults.tasks ?? []) as Array<Record<string, unknown>>
  const conditions = (moelResults.conditions ?? ['N', 'K', 'O']) as string[]
  const runName = String(moelResults.runName ?? 'unknown')
  const suite = String(moelResults.suite ?? 'unknown')

  const taskRows: TaskSummaryRow[] = []
  const condSums: Record<string, number> = {}
  const condCounts: Record<string, number> = {}
  for (const cond of conditions) { condSums[cond] = 0; condCounts[cond] = 0 }

  let hypothesisConfirmed = true

  for (const taskEntry of tasks) {
    const condResults = taskEntry as Record<string, { loss?: { lMoel?: number }, terminated?: boolean, terminatedBy?: string, taskId?: string }>
    const firstCond = conditions[0]
    const taskId = condResults[firstCond]?.taskId ?? 'unknown'

    const conditionResults: Record<string, TaskConditionResult> = {}
    for (const cond of conditions) {
      const r = condResults[cond]
      conditionResults[cond] = {
        lMoel: r?.loss?.lMoel ?? null,
        terminated: r?.terminated ?? false,
        terminatedBy: r?.terminatedBy ?? null,
      }
      if (r?.loss?.lMoel != null) {
        condSums[cond] += r.loss.lMoel
        condCounts[cond]++
      }
    }

    const n = conditionResults.N?.lMoel
    const k = conditionResults.K?.lMoel
    const nKDelta = n != null && k != null ? n - k : null
    const condHypothesis = n != null && k != null ? n > k : null
    if (condHypothesis === false) hypothesisConfirmed = false

    taskRows.push({
      taskId,
      conditions: conditionResults,
      nKDelta,
      hypothesisConfirmed: condHypothesis,
    })
  }

  const meanLMoelByCondition: Record<string, number | null> = {}
  for (const cond of conditions) {
    meanLMoelByCondition[cond] = condCounts[cond] > 0 ? condSums[cond] / condCounts[cond] : null
  }

  const meanN = meanLMoelByCondition.N
  const meanK = meanLMoelByCondition.K
  const nKDelta = meanN != null && meanK != null ? meanN - meanK : null

  return {
    runName,
    suite,
    hypothesisConfirmed,
    tasks: taskRows,
    aggregate: {
      meanLMoelByCondition,
      nKDelta,
    },
  }
}
