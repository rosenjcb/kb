/**
 * Boss → worker `task` tool: runs a nested agentLoop with filtered tools (Ticket 105).
 * Architecture (Mermaid UML): `src/core/ORCHESTRATOR.md`
 */

import { randomUUID } from 'node:crypto'
import { agentLoop } from '../core/agent-loop'
import { resolveAgentProfile } from '../core/agents/agent-registry'
import type { StreamManager } from '../core/runtime/stream-manager'
import type { ToolExecutor } from '../core/tool-registry'
import type { AgentEvent, LLMProvider, SubagentTaskResult, ToolUseRequest } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import {
  readSubagentEvalScenarioFromEnv,
  subagentLoopTuning,
} from './subagent-eval-scenario'

export interface ExecuteSubagentTaskParams {
  parentRegistry: ToolExecutor
  provider: LLMProvider
  input: Record<string, unknown>
  streamManager?: StreamManager
  /** Logical channel prefix (e.g. session id) for stream fan-in */
  parentChannelId?: string
}

const SUBAGENT_DELEGATION_PROMPT = loadPrompt('subagent-delegation.md')

function createFilteredToolExecutor(parent: ToolExecutor, allowed: Set<string>): ToolExecutor {
  return {
    register() {
      throw new Error('subagent tool registry is read-only')
    },
    getTools() {
      return parent.getTools().filter(t => allowed.has(t.name))
    },
    async execute(toolUse: ToolUseRequest) {
      if (!allowed.has(toolUse.name)) {
        throw new Error(`Tool '${toolUse.name}' is not available to this subagent`)
      }
      return parent.execute(toolUse)
    },
  }
}

function summarizeUsage(events: AgentEvent[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0
  let outputTokens = 0
  for (const ev of events) {
    if (ev.type === 'metadata') {
      inputTokens += ev.usage.inputTokens
      outputTokens += ev.usage.outputTokens
    }
  }
  return { inputTokens, outputTokens }
}

export async function executeSubagentTask(
  params: ExecuteSubagentTaskParams
): Promise<SubagentTaskResult> {
  const { parentRegistry, provider, input, streamManager, parentChannelId = 'parent' } = params

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) {
    return {
      status: 'error',
      subagentId: randomUUID(),
      isolation: 'shared_storage',
      textSegments: [],
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'task requires a non-empty "prompt" string',
    }
  }

  const scenario = readSubagentEvalScenarioFromEnv()
  const tuning = subagentLoopTuning(scenario)

  const explicitProfileId =
    typeof input.agent_profile_id === 'string' ? input.agent_profile_id.trim() : undefined
  const profileIdForResolve =
    explicitProfileId ??
    (tuning.defaultProfileIdWhenUnspecified === 'research' ? 'research' : undefined)
  const profile = resolveAgentProfile(profileIdForResolve)

  let maxTurns =
    typeof input.max_turns === 'number' && Number.isFinite(input.max_turns)
      ? Math.min(Math.max(1, Math.floor(input.max_turns)), 20)
      : profile.defaultMaxTurns
  if (tuning.maxTurnsCap !== undefined) {
    maxTurns = Math.min(maxTurns, tuning.maxTurnsCap)
  }

  const fromProfile = profile.defaultAllowedTools
  const allowedNames = Array.isArray(input.allowed_tools)
    ? input.allowed_tools.filter((x): x is string => typeof x === 'string')
    : [...fromProfile]

  const allowed = new Set(allowedNames.filter(n => n && n !== 'task'))
  if (allowed.size === 0) {
    return {
      status: 'error',
      subagentId: randomUUID(),
      isolation: 'shared_storage',
      textSegments: [],
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'allowed_tools is empty after removing the recursive task tool',
    }
  }

  const isolation =
    input.isolation === 'forked_message_thread' ? 'forked_message_thread' : 'shared_storage'

  const subagentId = randomUUID()
  const childExecutor = createFilteredToolExecutor(parentRegistry, allowed)
  const channelId = `${parentChannelId}:${subagentId}`

  const systemPrompt = [
    profile.systemPrompt,
    '',
    SUBAGENT_DELEGATION_PROMPT,
  ].join('\n')

  const textSegments: string[] = []
  const toolCalls: SubagentTaskResult['toolCalls'] = []
  const collected: AgentEvent[] = []

  try {
    for await (const event of agentLoop(prompt, provider, childExecutor, {
      maxTurns,
      systemPrompt,
      parallelToolCalls: tuning.parallelToolCalls,
    })) {
      collected.push(event)
      streamManager?.push(channelId, event)
      if (event.type === 'text' && event.content) {
        textSegments.push(event.content)
      }
      if (event.type === 'tool_result') {
        toolCalls.push({
          name: event.toolName,
          toolUseId: event.toolUseId,
          ok: !event.isError,
        })
      }
    }

    const usage = summarizeUsage(collected)
    return {
      status: 'success',
      subagentId,
      profileId: profile.id,
      isolation,
      textSegments,
      toolCalls,
      usage,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const usage = summarizeUsage(collected)
    return {
      status: 'error',
      subagentId,
      profileId: profile.id,
      isolation,
      textSegments,
      toolCalls,
      usage,
      error: message,
    }
  }
}
