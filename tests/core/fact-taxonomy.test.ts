import { describe, expect, it } from 'vitest'
import { classifyFactLane, inferQueryLaneWeights } from '@kb/core/core/fact-taxonomy.js'

describe('fact taxonomy', () => {
  it('[TC-58] classifies build-heavy fact text into build lane', () => {
    const lane = classifyFactLane('Build with cmake and install dependencies before compile step')
    expect(lane).toBe('build')
  })

  it('[TC-59] returns general lane when no keywords match', () => {
    const lane = classifyFactLane('entity ownership model discussed internally')
    expect(lane).toBe('general')
  })

  it('[TC-60] infers query lane weights from lane keywords', () => {
    const weights = inferQueryLaneWeights('what build flags and config options for linux')
    expect(weights.build).toBeDefined()
    expect(weights.config).toBeDefined()
    expect(weights.platform).toBeDefined()
  })
})
