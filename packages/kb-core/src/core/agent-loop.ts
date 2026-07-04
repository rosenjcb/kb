/**
 * Core Agent Loop - Your own queryLoop equivalent
 * Works with any LLM provider
 */

import dayjs from 'dayjs'
import type { RunCollector } from './telemetry'
import type { ToolExecutor } from './tool-registry'
import type { AgentEvent, LLMProvider, Message, ToolDefinition } from './types'

export interface AgentLoopConfig {
  maxTurns?: number
  maxTokens?: number
  temperature?: number
  collector?: RunCollector
  /** Optional system prompt forwarded to the provider (subagent / custom harness). */
  systemPrompt?: string
  /**
   * When true (default), tool calls returned in a single assistant turn are executed concurrently.
   * Order of `tool_start` / `tool_result` events remains aligned with the model's tool list.
   */
  parallelToolCalls?: boolean
}

/**
 * Agent loop: main streaming event generator
 * Yields events as they happen: text, tool execution, decisions
 */
export async function* agentLoop(
  userQuery: string,
  provider: LLMProvider,
  toolExecutor?: ToolExecutor,
  config: AgentLoopConfig = {}
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [
    {
      role: 'user',
      content: userQuery,
      metadata: { timestamp: dayjs().valueOf() },
    },
  ]

  const tools: ToolDefinition[] = toolExecutor?.getTools() ?? []
  const maxTurns = config.maxTurns ?? 10
  const parallelToolCalls = config.parallelToolCalls !== false
  let turnCount = 0

  while (turnCount < maxTurns) {
    turnCount++

    // Call LLM
    const turnStartMs = Date.now()
    const turnStartedAt = dayjs().toISOString()
    const response = await provider.call({
      messages,
      tools,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      systemPrompt: config.systemPrompt,
    })
    const turnDurationMs = Date.now() - turnStartMs

    // Yield text response
    if (response.text) {
      yield { type: 'text', content: response.text }
    }

    // Yield usage metadata
    yield {
      type: 'metadata',
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    }

    // Record telemetry for this turn
    if (config.collector) {
      const { estimateCost } = await import('./telemetry')
      config.collector.addStage({
        stage: `agentLoop:turn${turnCount}`,
        startedAt: turnStartedAt,
        durationMs: turnDurationMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        estimatedCostUsd: estimateCost(
          provider.name,
          provider.model,
          response.usage.inputTokens,
          response.usage.outputTokens
        ),
        provider: provider.name,
        model: provider.model,
      })
    }

    // Check for tool calls
    if (!response.toolUses.length) {
      yield { type: 'done', reason: 'no_tool_calls' }
      break
    }

    // Execute tools and collect results (parallel by default; preserve tool order)
    const toolUses = response.toolUses
    for (const toolUse of toolUses) {
      yield { type: 'tool_start', toolName: toolUse.name, toolUseId: toolUse.id }
    }

    const runOne = async (toolUse: (typeof toolUses)[number]) => {
      try {
        let result: unknown
        if (toolExecutor) {
          result = await toolExecutor.execute(toolUse)
        } else {
          result = { status: 'executed', tool: toolUse.name }
        }
        return {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result,
          isError: false as const,
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result: errorMsg,
          isError: true as const,
        }
      }
    }

    let toolResults: Awaited<ReturnType<typeof runOne>>[]
    if (parallelToolCalls) {
      toolResults = await Promise.all(toolUses.map(tu => runOne(tu)))
    } else {
      toolResults = []
      for (const tu of toolUses) {
        toolResults.push(await runOne(tu))
      }
    }

    for (const tr of toolResults) {
      yield {
        type: 'tool_result',
        toolUseId: tr.toolUseId,
        toolName: tr.toolName,
        result: tr.result,
        isError: tr.isError,
      }
    }

    // Add to message history and continue loop
    messages.push({
      role: 'assistant',
      content: response.text,
      toolUses: response.toolUses,
      metadata: { timestamp: dayjs().valueOf() },
    })

    messages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result',
        toolUseId: r.toolUseId,
        toolName: r.toolName,
        result: r.result,
        isError: r.isError,
      })),
      metadata: { timestamp: dayjs().valueOf() },
    })
  }

  if (turnCount >= maxTurns) {
    yield { type: 'done', reason: 'max_turns_reached' }
  }
}

/**
 * Simple runner that collects all events from agent loop
 * Useful for testing and simple scenarios
 */
export async function runAgent(
  userQuery: string,
  provider: LLMProvider,
  toolExecutor?: ToolExecutor,
  config?: AgentLoopConfig
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []

  for await (const event of agentLoop(userQuery, provider, toolExecutor, config)) {
    events.push(event)
  }

  return events
}
