/**
 * Tool Registry & Executor
 * Routes tool calls from agent to implementations
 * Ticket 009: Tool Registry & Executor
 */

import type { ToolDefinition, ToolUseRequest } from './types'

export type ToolImplementation = (input: Record<string, unknown>) => Promise<unknown>

export interface ToolExecutor {
  register(name: string, def: ToolDefinition, impl: ToolImplementation): void
  getTools(): ToolDefinition[]
  execute(toolUse: ToolUseRequest): Promise<unknown>
}

/**
 * Default in-memory tool registry
 */
export function createToolRegistry(): ToolExecutor {
  const tools = new Map<string, { def: ToolDefinition; impl: ToolImplementation }>()

  return {
    register(name: string, def: ToolDefinition, impl: ToolImplementation) {
      tools.set(name, { def, impl })
    },

    getTools(): ToolDefinition[] {
      return Array.from(tools.values()).map(t => t.def)
    },

    async execute(toolUse: ToolUseRequest): Promise<unknown> {
      const tool = tools.get(toolUse.name)
      if (!tool) {
        throw new Error(`Tool not found: ${toolUse.name}`)
      }

      try {
        return await tool.impl(toolUse.input)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`Tool execution failed (${toolUse.name}): ${msg}`)
      }
    },
  }
}
