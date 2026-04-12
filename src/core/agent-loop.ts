/**
 * Core Agent Loop - Your own queryLoop equivalent
 * Works with any LLM provider
 */

import type { AgentEvent, Message, ToolDefinition, LLMProvider } from './types'
import type { ToolExecutor } from './tool-registry'

export interface AgentLoopConfig {
  maxTurns?: number
  maxTokens?: number
  temperature?: number
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
      metadata: { timestamp: Date.now() },
    },
  ]

  const tools: ToolDefinition[] = toolExecutor?.getTools() ?? []
  const maxTurns = config.maxTurns ?? 10
  let turnCount = 0

  while (turnCount < maxTurns) {
    turnCount++

    // Call LLM
    const response = await provider.call({
      messages,
      tools,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    })

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

    // Check for tool calls
    if (!response.toolUses.length) {
      yield { type: 'done', reason: 'no_tool_calls' }
      break
    }

    // Execute tools and collect results
    const toolResults: Array<{ toolUseId: string; toolName: string; result: unknown; isError: boolean }> = []

    for (const toolUse of response.toolUses) {
      yield { type: 'tool_start', toolName: toolUse.name, toolUseId: toolUse.id }

      try {
        let result: unknown
        if (toolExecutor) {
          result = await toolExecutor.execute(toolUse)
        } else {
          // Fallback mock for testing
          result = { status: 'executed', tool: toolUse.name }
        }

        toolResults.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result,
          isError: false,
        })

        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          result,
          isError: false,
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        toolResults.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result: errorMsg,
          isError: true,
        })

        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          result: errorMsg,
          isError: true,
        }
      }
    }

    // Add to message history and continue loop
    messages.push({
      role: 'assistant',
      content: response.text,
      metadata: { timestamp: Date.now() },
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
      metadata: { timestamp: Date.now() },
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
