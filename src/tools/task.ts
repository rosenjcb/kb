/**
 * Boss → worker `task` tool: runs a nested agentLoop with filtered tools (Ticket 105).
 * Architecture (Mermaid UML): `src/core/ORCHESTRATOR.md`
 */

import { randomUUID } from 'node:crypto'
import { agentLoop } from '../core/agent-loop'
import { resolveAgentProfile } from '../core/agents/agent-registry'
import { createInMemoryOmpSession } from '../core/omp-runtime'
import type { StreamManager } from '../core/runtime/stream-manager'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, SubagentTaskResult, ToolUseRequest } from '../core/types'
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

function summarizeUsage(
  events: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number } }>
): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0
  let outputTokens = 0
  for (const ev of events) {
    if (ev.type === 'metadata' && ev.usage) {
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
    'You are running as a delegated subagent. Complete the instruction using your tools.',
    'Be concise; the parent agent integrates your output.',
  ].join('\n')

  const textSegments: string[] = []
  const toolCalls: SubagentTaskResult['toolCalls'] = []
  const collected: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number } }> =
    []

  try {
    const customTools = childExecutor.getTools().map(tool => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.schema as Record<string, unknown>,
      execute: async (toolCallId: string, toolParams: unknown) => {
        try {
          const result = await childExecutor.execute({
            id: toolCallId,
            name: tool.name,
            input: toolParams as Record<string, unknown>,
          })
          toolCalls.push({ name: tool.name, toolUseId: toolCallId, ok: true })
          streamManager?.push(channelId, {
            type: 'tool_result',
            toolName: tool.name,
            toolUseId: toolCallId,
            isError: false,
            result,
          })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toolCalls.push({ name: tool.name, toolUseId: toolCallId, ok: false })
          streamManager?.push(channelId, {
            type: 'tool_result',
            toolName: tool.name,
            toolUseId: toolCallId,
            isError: true,
            result: message,
          })
          return { content: [{ type: 'text', text: message }], isError: true }
        }
      },
    }))

    try {
      const model = { provider: provider.name, id: provider.model } as never
      const { session } = await createInMemoryOmpSession({
        cwd: process.cwd(),
        model,
        customTools,
        enableMCP: false,
        enableLsp: false,
        systemPrompt,
      })
      try {
        await session.prompt(prompt, { attribution: 'agent' })
        await session.waitForIdle()
        const last = session.getLastAssistantMessage()
        const answerContent = (last as { content?: unknown } | undefined)?.content
        const answer = typeof answerContent === 'string' ? answerContent.trim() : ''
        if (answer) {
          textSegments.push(answer)
          streamManager?.push(channelId, { type: 'text', content: answer })
        }
      } finally {
        await session.dispose()
      }
    } catch {
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
    }

    return {
      status: 'success',
      subagentId,
      profileId: profile.id,
      isolation,
      textSegments,
      toolCalls,
      usage: summarizeUsage(collected),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: 'error',
      subagentId,
      profileId: profile.id,
      isolation,
      textSegments,
      toolCalls,
      usage: { inputTokens: 0, outputTokens: 0 },
      error: message,
    }
  }
}
