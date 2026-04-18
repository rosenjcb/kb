/**
 * Agent profiles for delegated `task` / subagent runs (Ticket 105).
 */

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
  systemPrompt:
    'You are a focused worker agent with access only to the tools provided. Prefer evidence-backed answers.',
  defaultMaxTurns: 6,
  defaultAllowedTools: ['read_documents'],
}

const researchProfile: AgentProfile = {
  id: 'research',
  label: 'Research worker',
  systemPrompt:
    'You specialize in locating and summarizing KB evidence. Prefer read_documents; cite document IDs when possible.',
  defaultMaxTurns: 8,
  defaultAllowedTools: ['read_documents'],
}

registerAgentProfile(defaultProfile)
registerAgentProfile(researchProfile)
