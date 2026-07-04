/**
 * Tool executor and registry
 * See: Ticket 009 - Tool Executor and Dispatch Logic
 * See: Ticket 004 - Tool Invocation Envelope
 */

import dayjs from 'dayjs'
import type { ToolResultEnvelope, ToolUseRequest } from '../core/types'

export interface ExecutableTool {
  name: string
  execute(input: Record<string, unknown>): Promise<unknown>
}

export interface ToolRegistry {
  register(tool: ExecutableTool): void
  get(name: string): ExecutableTool | undefined
  list(): ExecutableTool[]
}

export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, ExecutableTool>()

  register(tool: ExecutableTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): ExecutableTool | undefined {
    return this.tools.get(name)
  }

  list(): ExecutableTool[] {
    return Array.from(this.tools.values())
  }
}

export interface ToolExecutorOptions {
  timeout?: number
  checkPermissions?: (toolName: string) => Promise<boolean>
}

export interface ToolExecutor {
  execute(request: ToolUseRequest, options?: ToolExecutorOptions): Promise<ToolResultEnvelope>
}

export class ToolExecutorImpl implements ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private defaultOptions: ToolExecutorOptions = {}
  ) {}

  async execute(
    request: ToolUseRequest,
    options?: ToolExecutorOptions
  ): Promise<ToolResultEnvelope> {
    const opts = { ...this.defaultOptions, ...options }
    const startTime = dayjs().toISOString()
    const startMs = performance.now()

    // 1. Check tool exists
    const tool = this.registry.get(request.name)
    if (!tool) {
      const durationMs = Math.round(performance.now() - startMs)
      return {
        toolUseId: request.id,
        toolName: request.name,
        success: false,
        error: `Tool '${request.name}' not found`,
        metrics: {
          startTime,
          durationMs,
          resultSizeBytes: 0,
        },
      }
    }

    // 2. Check permissions (if provided)
    if (opts.checkPermissions) {
      const permissionStart = performance.now()
      try {
        const allowed = await opts.checkPermissions(request.name)
        const permissionCheckDurationMs = Math.round(performance.now() - permissionStart)

        if (!allowed) {
          const durationMs = Math.round(performance.now() - startMs)
          return {
            toolUseId: request.id,
            toolName: request.name,
            success: false,
            error: `Tool '${request.name}' denied by policy`,
            metrics: {
              startTime,
              durationMs,
              permissionCheckDurationMs,
              resultSizeBytes: 0,
            },
          }
        }
      } catch (err) {
        const durationMs = Math.round(performance.now() - startMs)
        const error = err instanceof Error ? err.message : String(err)
        return {
          toolUseId: request.id,
          toolName: request.name,
          success: false,
          error: `Permission check failed: ${error}`,
          metrics: {
            startTime,
            durationMs,
            resultSizeBytes: 0,
          },
        }
      }
    }

    // 3. Execute tool with timeout
    let result: unknown
    let error: string | undefined

    try {
      const timeoutMs = opts.timeout ?? 30000
      result = await Promise.race([
        tool.execute(request.input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ])
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    const durationMs = Math.round(performance.now() - startMs)
    const resultSizeBytes = JSON.stringify(result ?? error).length

    return {
      toolUseId: request.id,
      toolName: request.name,
      success: !error,
      content: result,
      error,
      metrics: {
        startTime,
        durationMs,
        resultSizeBytes,
      },
    }
  }
}
