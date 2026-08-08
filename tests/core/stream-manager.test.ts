import { describe, expect, it } from 'vitest'
import { StreamManager } from '@kb/core/core/runtime/stream-manager.js'

describe('StreamManager', () => {
  it('[TC-117] Given push then snapshot, then returns copy without clearing', () => {
    const sm = new StreamManager()
    sm.push('c1', { type: 'text', content: 'a' })
    expect(sm.snapshot('c1')).toHaveLength(1)
    expect(sm.snapshot('c1')).toHaveLength(1)
  })

  it('[TC-118] Given drain, then removes buffer for channel', () => {
    const sm = new StreamManager()
    sm.push('c1', { type: 'text', content: 'x' })
    const first = sm.drain('c1')
    const second = sm.drain('c1')
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})
