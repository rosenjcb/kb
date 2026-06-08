import { describe, expect, it } from 'vitest'
import { compareConditions, computeMoel } from '../../eval/losses/moel'
import type { MoelComponents, MoelWeights } from '../../eval/losses/moel'

const DEFAULT_WEIGHTS: MoelWeights = { wC: 0.5, wT: 0.3, wR: 0.2, mu: 0.6 }

describe('computeMoel', () => {
  it('Given all zero losses, lMoel = 0', () => {
    const components: MoelComponents = { lAst: 0, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(computeMoel(components, DEFAULT_WEIGHTS, 'task-1', 'K').lMoel).toBe(0)
  })

  it('Given all maximum losses, lMoel = 1', () => {
    const components: MoelComponents = { lAst: 1, lJury: 1, lTrajectory: 1, lResource: 1 }
    expect(computeMoel(components, DEFAULT_WEIGHTS, 'task-1', 'K').lMoel).toBe(1)
  })

  it('Given mu = 0, lCorrectness equals lJury only', () => {
    const weights: MoelWeights = { ...DEFAULT_WEIGHTS, mu: 0 }
    const components: MoelComponents = { lAst: 1, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(computeMoel(components, weights, 'task-1', 'K').lCorrectness).toBe(0)
  })

  it('Given mu = 1, lCorrectness equals lAst only', () => {
    const weights: MoelWeights = { ...DEFAULT_WEIGHTS, mu: 1 }
    const components: MoelComponents = { lAst: 1, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(computeMoel(components, weights, 'task-1', 'K').lCorrectness).toBe(1)
  })

  it('Given weights that do not sum to 1, throws with sum in message', () => {
    const weights: MoelWeights = { wC: 0.5, wT: 0.3, wR: 0.3, mu: 0.6 }
    const c: MoelComponents = { lAst: 0, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(() => computeMoel(c, weights, 't', 'K')).toThrow('sum must equal 1.0')
  })

  it('Given a negative weight, throws', () => {
    const weights: MoelWeights = { wC: -0.1, wT: 0.6, wR: 0.5, mu: 0.6 }
    const c: MoelComponents = { lAst: 0, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(() => computeMoel(c, weights, 't', 'K')).toThrow()
  })

  it('Given mu > 1, throws', () => {
    const weights: MoelWeights = { ...DEFAULT_WEIGHTS, mu: 1.5 }
    const c: MoelComponents = { lAst: 0, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(() => computeMoel(c, weights, 't', 'K')).toThrow()
  })

  it('Given a loss component outside [0,1], throws', () => {
    const c: MoelComponents = { lAst: 1.5, lJury: 0, lTrajectory: 0, lResource: 0 }
    expect(() => computeMoel(c, DEFAULT_WEIGHTS, 't', 'K')).toThrow()
  })

  it('Result serializes to JSON with no undefined values', () => {
    const c: MoelComponents = { lAst: 0.3, lJury: 0.4, lTrajectory: 0.2, lResource: 0.1 }
    const result = computeMoel(c, DEFAULT_WEIGHTS, 'task-1', 'K')
    const json = JSON.parse(JSON.stringify(result))
    for (const [key, value] of Object.entries(json)) {
      expect(value, `field ${key} should not be undefined`).not.toBeUndefined()
    }
  })

  it('taskId and condition are set on the result', () => {
    const c: MoelComponents = { lAst: 0, lJury: 0, lTrajectory: 0, lResource: 0 }
    const result = computeMoel(c, DEFAULT_WEIGHTS, 'my-task', 'N')
    expect(result.taskId).toBe('my-task')
    expect(result.condition).toBe('N')
  })
})

describe('compareConditions', () => {
  it('Given N > K, hypothesisConfirmed is true and N-K delta is positive', () => {
    const n = computeMoel(
      { lAst: 0.8, lJury: 0.7, lTrajectory: 0.9, lResource: 0.8 },
      DEFAULT_WEIGHTS,
      'task-1',
      'N'
    )
    const k = computeMoel(
      { lAst: 0.3, lJury: 0.4, lTrajectory: 0.2, lResource: 0.1 },
      DEFAULT_WEIGHTS,
      'task-1',
      'K'
    )
    const report = compareConditions({ N: n, K: k })
    expect(report.hypothesisConfirmed).toBe(true)
    expect(report.pairwise['N-K']).toBeGreaterThan(0)
    expect(report.conditions).toEqual(['N', 'K'])
  })

  it('Given K > N, hypothesisConfirmed is false', () => {
    const n = computeMoel(
      { lAst: 0.1, lJury: 0.1, lTrajectory: 0.1, lResource: 0.1 },
      DEFAULT_WEIGHTS,
      'task-1',
      'N'
    )
    const k = computeMoel(
      { lAst: 0.9, lJury: 0.9, lTrajectory: 0.9, lResource: 0.9 },
      DEFAULT_WEIGHTS,
      'task-1',
      'K'
    )
    expect(compareConditions({ N: n, K: k }).hypothesisConfirmed).toBe(false)
  })

  it('Given only K condition, hypothesisConfirmed is false', () => {
    const k = computeMoel(
      { lAst: 0.3, lJury: 0.4, lTrajectory: 0.2, lResource: 0.1 },
      DEFAULT_WEIGHTS,
      'task-1',
      'K'
    )
    expect(compareConditions({ K: k }).hypothesisConfirmed).toBe(false)
  })

  it('Three conditions produce all pairwise entries', () => {
    const make = (v: number, cond: string) =>
      computeMoel({ lAst: v, lJury: v, lTrajectory: v, lResource: v }, DEFAULT_WEIGHTS, 't', cond)
    const report = compareConditions({ N: make(0.8, 'N'), K: make(0.4, 'K'), O: make(0.1, 'O') })
    expect(Object.keys(report.pairwise)).toEqual(expect.arrayContaining(['N-K', 'N-O', 'K-O']))
  })
})
