import { describe, expect, it } from 'vitest'
import {
  getAgentProfile,
  listAgentProfiles,
  resolveAgentProfile,
} from '@kb/core/core/agents/agent-registry.js'

describe('agent registry', () => {
  it('[TC-6] Given seeded profiles, then listAgentProfiles includes default and research', () => {
    const ids = listAgentProfiles().map(p => p.id)
    expect(ids).toContain('default')
    expect(ids).toContain('research')
  })

  it('[TC-7] Given unknown profile id, then resolveAgentProfile falls back to default', () => {
    const p = resolveAgentProfile('no-such-profile')
    expect(p.id).toBe('default')
  })

  it('[TC-8] Given research id, then resolveAgentProfile returns research profile', () => {
    const p = resolveAgentProfile('research')
    expect(p.id).toBe('research')
    expect(p.defaultAllowedTools).toContain('read_facts')
  })

  it('[TC-9] Given getAgentProfile, then returns undefined for unknown id', () => {
    expect(getAgentProfile('absent')).toBeUndefined()
  })
})
