import { describe, expect, it } from 'vitest'
import { buildSummaryJson, buildSummaryMarkdown } from '../../eval/reports/summary'

// Helpers to build fixture moelResults objects
function makeResult(taskId: string, n: number | null, k: number | null, o: number | null = null) {
  const cond = (lMoel: number | null) =>
    lMoel !== null
      ? { loss: { lMoel }, terminated: false, terminatedBy: null, taskId }
      : { terminated: true, terminatedBy: 'step_ceiling', taskId }
  return { N: cond(n), K: cond(k), O: cond(o) }
}

const singleTask = {
  runName: 'test-run-1',
  suite: 'kb',
  conditions: ['N', 'K', 'O'],
  tasks: [makeResult('task-alpha', 0.8, 0.4, 0.2)],
}

const twoTasks = {
  runName: 'test-run-2',
  suite: 'kb',
  conditions: ['N', 'K', 'O'],
  tasks: [makeResult('task-alpha', 0.8, 0.4, 0.2), makeResult('task-beta', 0.6, 0.5, 0.3)],
}

// ── buildSummaryMarkdown ──────────────────────────────────────────────────────

describe('buildSummaryMarkdown', () => {
  it('[TC-3AG4] includes run name and suite in header', () => {
    const md = buildSummaryMarkdown(singleTask)
    expect(md).toContain('test-run-1')
    expect(md).toContain('kb')
  })

  it('[TC-AEFX] renders task id in the table', () => {
    const md = buildSummaryMarkdown(singleTask)
    expect(md).toContain('task-alpha')
  })

  it('[TC-K1B1] shows positive N-K delta when N > K', () => {
    const md = buildSummaryMarkdown(singleTask)
    expect(md).toMatch(/\+0\.400/)
  })

  it('[TC-91TX] shows hypothesisConfirmed: true when N > K for all tasks', () => {
    const md = buildSummaryMarkdown(singleTask)
    expect(md).toMatch(/hypothesisConfirmed.*true/)
  })

  it('[TC-VP45] shows hypothesisConfirmed: false when K >= N for any task', () => {
    const flipped = {
      ...singleTask,
      tasks: [makeResult('task-flip', 0.3, 0.9)],
    }
    const md = buildSummaryMarkdown(flipped)
    expect(md).toMatch(/hypothesisConfirmed.*false/)
  })

  it('[TC-3BG0] renders aggregate row', () => {
    const md = buildSummaryMarkdown(twoTasks)
    expect(md).toContain('Aggregate')
  })

  it('[TC-J6UY] shows dash for null lMoel values', () => {
    const withNull = {
      ...singleTask,
      tasks: [makeResult('task-null', null, 0.4)],
    }
    const md = buildSummaryMarkdown(withNull)
    expect(md).toContain('-')
  })

  it('[TC-PNB7] contains correct number of table separator rows', () => {
    const md = buildSummaryMarkdown(singleTask)
    const separators = md.split('\n').filter(line => /^\|[-| ]+\|$/.test(line))
    expect(separators.length).toBeGreaterThanOrEqual(2)
  })
})

// ── buildSummaryJson ──────────────────────────────────────────────────────────

describe('buildSummaryJson', () => {
  it('[TC-EHZH] returns correct runName and suite', () => {
    const result = buildSummaryJson(singleTask)
    expect(result.runName).toBe('test-run-1')
    expect(result.suite).toBe('kb')
  })

  it('[TC-XCFB] hypothesisConfirmed is true when N > K for all tasks', () => {
    const result = buildSummaryJson(singleTask)
    expect(result.hypothesisConfirmed).toBe(true)
  })

  it('[TC-RJBS] hypothesisConfirmed is false when K > N for any task', () => {
    const flipped = {
      ...singleTask,
      tasks: [makeResult('task-flip', 0.3, 0.9)],
    }
    expect(buildSummaryJson(flipped).hypothesisConfirmed).toBe(false)
  })

  it('[TC-XEMC] taskRows have correct lMoel values', () => {
    const result = buildSummaryJson(singleTask)
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].conditions.N.lMoel).toBeCloseTo(0.8)
    expect(result.tasks[0].conditions.K.lMoel).toBeCloseTo(0.4)
  })

  it('[TC-FU9T] nKDelta is N minus K', () => {
    const result = buildSummaryJson(singleTask)
    expect(result.tasks[0].nKDelta).toBeCloseTo(0.4)
  })

  it('[TC-AUEJ] nKDelta is null when either N or K is missing', () => {
    const withNull = {
      ...singleTask,
      tasks: [makeResult('task-null', null, 0.4)],
    }
    expect(buildSummaryJson(withNull).tasks[0].nKDelta).toBeNull()
  })

  it('[TC-8Z2B] per-task hypothesisConfirmed is null when either condition is missing', () => {
    const withNull = {
      ...singleTask,
      tasks: [makeResult('task-null', null, 0.4)],
    }
    expect(buildSummaryJson(withNull).tasks[0].hypothesisConfirmed).toBeNull()
  })

  it('[TC-LES6] aggregate meanLMoelByCondition is mean across tasks', () => {
    const result = buildSummaryJson(twoTasks)
    expect(result.aggregate.meanLMoelByCondition.N).toBeCloseTo((0.8 + 0.6) / 2)
    expect(result.aggregate.meanLMoelByCondition.K).toBeCloseTo((0.4 + 0.5) / 2)
  })

  it('[TC-JL4K] aggregate nKDelta is mean N minus mean K', () => {
    const result = buildSummaryJson(twoTasks)
    const expectedN = (0.8 + 0.6) / 2
    const expectedK = (0.4 + 0.5) / 2
    expect(result.aggregate.nKDelta).toBeCloseTo(expectedN - expectedK)
  })

  it('[TC-Y7WN] handles empty tasks array without throwing', () => {
    const empty = { runName: 'empty', suite: 'kb', conditions: ['N', 'K'], tasks: [] }
    const result = buildSummaryJson(empty)
    expect(result.tasks).toHaveLength(0)
    expect(result.aggregate.nKDelta).toBeNull()
  })

  it('[TC-KMJG] terminated conditions show lMoel null and terminated true', () => {
    const withTerminated = {
      ...singleTask,
      tasks: [makeResult('task-term', null, 0.4)],
    }
    const result = buildSummaryJson(withTerminated)
    expect(result.tasks[0].conditions.N.lMoel).toBeNull()
    expect(result.tasks[0].conditions.N.terminated).toBe(true)
  })
})
