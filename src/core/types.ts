/**
 * Unified type definitions for the agent harness
 * Works across all LLM providers
 */

// ─── Message Types ───────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant'
  content: string | ToolResultBlock[]
  metadata?: {
    timestamp: number
    tokenCount?: number
    model?: string
  }
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  toolName: string
  result: unknown
  isError?: boolean
}

// ─── Tool Definition ─────────────────────────────────────────────

/**
 * Tool Definition Contract
 *
 * Design Principle: Each tool has exactly ONE responsibility.
 * Tool names document intent. Separatate tools by action, not mode.
 *
 * ✅ Do this:
 *   - merge_documents: consolidate two docs
 *   - append_to_document: add content
 *   - update_document: replace content
 *
 * ❌ Don't do this:
 *   - write_document with operationMode=merge|append|replace
 *
 * Rationale: Intent is self-documenting; fewer parameters; easier testing.
 * See src/tools/TOOL_CONVENTIONS.md for full guidelines.
 */
export interface ToolDefinition {
  name: string
  description: string
  schema: Record<string, unknown> // JSON Schema
  metadata?: {
    permissions?: {
      role: string
      allowed?: boolean
      denied_patterns?: string[]
      rateLimit?: string
    }[]
    timeout?: number
    maxTokens?: number
  }
}

// ─── Tool Invocation & Results (Ticket 004) ──────────────────────

export interface ToolUseRequest {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolExecutionMetrics {
  startTime: string
  durationMs: number
  permissionCheckDurationMs?: number
  preHookDurationMs?: number
  resultSizeBytes: number
}

export interface ToolResultEnvelope {
  toolUseId: string
  toolName: string
  success: boolean
  content?: unknown
  error?: string
  metrics: ToolExecutionMetrics
}

// ─── LLM Provider Interface ──────────────────────────────────────

export interface LLMResponse {
  text: string
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error'
  toolUses: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface LLMStreamChunk {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_input_delta' | 'done'
  content?: string
  toolUseId?: string
  toolName?: string
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  readonly supportsStreaming: boolean

  call(params: LLMCallParams): Promise<LLMResponse>
  callStream?(params: LLMCallParams): AsyncGenerator<LLMStreamChunk>
}

export interface LLMCallParams {
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  /**
   * Gemini 2.5+ only: `thinkingBudget: 0` turns off internal reasoning so output
   * tokens are available for the model reply (needed for strict JSON extractors).
   */
  thinkingBudget?: number
}

// ─── Session State ──────────────────────────────────────────────

export interface Session {
  id: string
  created: number
  updated: number
  messages: Message[]
  config: {
    model: string
    provider: string
    endpoint?: string
  }
  metadata?: {
    title?: string
    userRole?: string
    tags?: string[]
  }
}

// ─── Decision Log ───────────────────────────────────────────────

export interface Decision {
  timestamp: number
  category:
    | 'permission'
    | 'tool_execution'
    | 'early_termination'
    | 'tool_rejection'
    | 'model_selection'
  context: {
    userRole?: string
    toolName?: string
    reason?: string
    modelName?: string
  }
  decision: 'allow' | 'deny' | 'defer' | 'timeout'
  evidence?: string[]
}

// ─── Agent Loop Events ──────────────────────────────────────────

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'decision'; decision: Decision }
  | { type: 'done'; reason: string }
  | { type: 'error'; error: Error }
  | { type: 'metadata'; usage: { inputTokens: number; outputTokens: number } }

// ─── Subagent orchestration (Ticket 105) ───────────────────────

/** How the subagent relates to parent storage (v1: logical thread only). */
export type SubagentIsolationStrategy = 'shared_storage' | 'forked_message_thread'

/** Boss → worker delegation envelope consumed by the `task` tool. */
export interface SubagentTaskSpec {
  prompt: string
  agentProfileId?: string
  maxTurns?: number
  allowedTools?: string[]
  isolation?: SubagentIsolationStrategy
}

/** Structured result returned to the parent model as `task` tool output. */
export interface SubagentTaskResult {
  status: 'success' | 'error'
  subagentId: string
  profileId?: string
  isolation: SubagentIsolationStrategy
  textSegments: string[]
  toolCalls: Array<{ name: string; toolUseId: string; ok: boolean }>
  usage: { inputTokens: number; outputTokens: number }
  error?: string
}
