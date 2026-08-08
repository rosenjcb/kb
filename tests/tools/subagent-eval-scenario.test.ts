import { describe, expect, it } from 'vitest'
import {
  type SubagentEvalScenario,
  subagentLoopTuning,
} from '@kb/core/tools/subagent-eval-scenario.js'

describe('subagentLoopTuning', () => {
  it.each<[SubagentEvalScenario, ReturnType<typeof subagentLoopTuning>]>([
    [
      'default',
      {
        parallelToolCalls: true,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'default',
      },
    ],
    [
      's1',
      {
        parallelToolCalls: false,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'default',
      },
    ],
    ['s2', { parallelToolCalls: true, maxTurnsCap: 3, defaultProfileIdWhenUnspecified: 'default' }],
    [
      's3',
      {
        parallelToolCalls: true,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'research',
      },
    ],
  ])('[TC-69] Given scenario %s, then returns expected tuning', (scenario, expected) => {
    expect(subagentLoopTuning(scenario)).toEqual(expected)
  })
})
