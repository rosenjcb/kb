/**
 * Agent profiles for delegated `task` / subagent runs (Ticket 105).
 */

import { loadPrompt } from '../../prompts/loader'

export interface AgentProfile {
  id: string
  label: string
  systemPrompt: string
  defaultMaxTurns: number
  defaultAllowedTools: string[]
}

const profiles = new Map<string, AgentProfile>()

export function registerAgentProfile(profile: AgentProfile): void {
  profiles.set(profile.id, profile)
}

export function listAgentProfiles(): AgentProfile[] {
  return Array.from(profiles.values())
}

export function getAgentProfile(id: string): AgentProfile | undefined {
  return profiles.get(id)
}

export function resolveAgentProfile(id?: string): AgentProfile {
  if (id && profiles.has(id)) {
    return profiles.get(id) as AgentProfile
  }
  return profiles.get('default') as AgentProfile
}

const defaultProfile: AgentProfile = {
  id: 'default',
  label: 'Default worker',
  systemPrompt: loadPrompt('agent-default.md'),
  defaultMaxTurns: 6,
  defaultAllowedTools: ['read_facts'],
}

const researchProfile: AgentProfile = {
  id: 'research',
  label: 'Research worker',
  systemPrompt: loadPrompt('agent-research.md'),
  defaultMaxTurns: 8,
  defaultAllowedTools: ['read_facts'],
}

registerAgentProfile(defaultProfile)
registerAgentProfile(researchProfile)
