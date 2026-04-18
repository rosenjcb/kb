/**
 * Optional eval / A-B knobs for nested `task` runs (Ticket 106).
 * Set `KB_SUBAGENT_SCENARIO` to vary subagent loop behavior without changing call sites.
 */

/** Subagent A/B tuning label (`default` = unset env, normal loop). Not related to KB `--base` names. */
export type SubagentEvalScenario = 'default' | 's1' | 's2' | 's3'

export function readSubagentEvalScenarioFromEnv(): SubagentEvalScenario {
  const raw = process.env.KB_SUBAGENT_SCENARIO?.trim().toLowerCase()
  if (raw === 's1' || raw === 's2' || raw === 's3') {
    return raw
  }
  return 'default'
}

export interface SubagentLoopTuning {
  /** When false, tool batches in one model turn run sequentially (Ticket 106 scenario s1). */
  parallelToolCalls: boolean
  /** Hard cap on agentLoop turns for this subagent run (undefined = no extra cap). */
  maxTurnsCap: number | undefined
  /** When the model omits `agent_profile_id`, which profile id to use before `resolveAgentProfile`. */
  defaultProfileIdWhenUnspecified: 'default' | 'research'
}

/**
 * Maps `KB_SUBAGENT_SCENARIO` to nested-loop tuning (Ticket 106).
 *
 * | Scenario | Intent |
 * |----------|--------|
 * | default | Env unset / unknown: parallel tools, normal agent profiles. |
 * | s1 | Sequential tool execution inside one assistant turn. |
 * | s2 | Turn cap 3 on nested `agentLoop`. |
 * | s3 | If `agent_profile_id` omitted, use `research` profile. |
 */
export function subagentLoopTuning(scenario: SubagentEvalScenario): SubagentLoopTuning {
  switch (scenario) {
    case 's1':
      return {
        parallelToolCalls: false,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'default',
      }
    case 's2':
      return {
        parallelToolCalls: true,
        maxTurnsCap: 3,
        defaultProfileIdWhenUnspecified: 'default',
      }
    case 's3':
      return {
        parallelToolCalls: true,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'research',
      }
    default:
      return {
        parallelToolCalls: true,
        maxTurnsCap: undefined,
        defaultProfileIdWhenUnspecified: 'default',
      }
  }
}
