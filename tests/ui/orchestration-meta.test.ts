import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationMetaLine,
  isOrchestrationMetaLine,
  orchestrationWireKey,
} from '@kb/core/ui/orchestration-meta.js'

describe('ui/orchestration-meta', () => {
  it('[TC-1] Given human labels, then wire keys are lowercase slugs', () => {
    expect(orchestrationWireKey('Relevant Docs')).toBe('relevant_docs')
    expect(orchestrationWireKey('Match IDs')).toBe('match_ids')
    expect(orchestrationWireKey('retrieval')).toBe('retrieval')
  })

  it('[TC-2] Given a line, then detects orchestration wire rows but not assistant stream', () => {
    expect(isOrchestrationMetaLine('summary> Found 3 docs')).toBe(true)
    expect(isOrchestrationMetaLine('  thinking> hybrid:hit->return')).toBe(true)
    expect(isOrchestrationMetaLine('relevant_docs>')).toBe(true)
    expect(isOrchestrationMetaLine('relevant_docs> ')).toBe(true)
    expect(isOrchestrationMetaLine('relevant_docs> none')).toBe(true)
    expect(isOrchestrationMetaLine('assistant> hello')).toBe(false)
    expect(isOrchestrationMetaLine('Plain answer text')).toBe(false)
  })

  it('[TC-3] Given label and value, then formats wire line', () => {
    expect(formatOrchestrationMetaLine('Summary', 'x')).toBe('summary> x')
  })
})
