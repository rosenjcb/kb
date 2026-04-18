import { describe, expect, it } from 'vitest'
import {
  type SubagentEvalScenario,
  subagentLoopTuning,
} from '../../src/tools/subagent-eval-scenario'

describe('subagentLoopTuning', () => {
  it.each<[SubagentEvalScenario, ReturnType<typeof subagentLoopTuning>]>([
    ['default', { parallelToolCalls: true, maxTurnsCap: undefined, defaultProfileIdWhenUnspecified: 'default' }],
    ['s1', { parallelToolCalls: false, maxTurnsCap: undefined, defaultProfileIdWhenUnspecified: 'default' }],
    ['s2', { parallelToolCalls: true, maxTurnsCap: 3, defaultProfileIdWhenUnspecified: 'default' }],
    ['s3', { parallelToolCalls: true, maxTurnsCap: undefined, defaultProfileIdWhenUnspecified: 'research' }],
  ])('Given scenario %s, then returns expected tuning', (scenario, expected) => {
    expect(subagentLoopTuning(scenario)).toEqual(expected)
  })
})
