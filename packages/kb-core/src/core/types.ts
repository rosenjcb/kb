/**
 * Unified type definitions for the agent harness
 * Works across all LLM providers
 */

// ─── Message Types ───────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant'
  content: string | ToolResultBlock[]
  /** Tool calls made by an assistant message (used to round-trip tool_use through providers). */
  toolUses?: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    /** Gemini 2.5+/3.x return an opaque signature per function call that must be
     *  echoed back verbatim on the next turn, or tool round-trips fail with a 400. */
    thoughtSignature?: string
  }>
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
 * Design principle: each tool has one responsibility; tool names document intent.
 * Default **`createKBToolsRegistry`** surface is facts + graph + optional **`task`** (no markdown mutators).
 * See `src/tools/TOOL_CONVENTIONS.md` for authoring guidelines when adding tools.
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
    thoughtSignature?: string
  }>
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface LLMStreamChunk {
  type: 'text_delta' | 'reasoning_delta' | 'tool_use_start' | 'tool_use_input_delta' | 'done'
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

/** Native structured JSON when the provider supports it (see `OpenAIProvider`, `GeminiProvider`). */
export interface LLMStructuredJsonRequest {
  /** OpenAI Chat Completions `response_format.type: json_schema` (strict). */
  openai?: { name: string; schema: Record<string, unknown> }
  /** Gemini `generationConfig.responseSchema` + `responseMimeType: application/json`. */
  gemini?: Record<string, unknown>
}

export interface LLMCallParams {
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  /**
   * Thinking / reasoning token budget. On Gemini 2.5/3 this maps to
   * `thinkingConfig.thinkingBudget` (`0` disables thinking). When omitted, the
   * Gemini provider resolves via `GEMINI_THINKING_BUDGET` env, else defaults to
   * 1024 when `onReasoning` is set and 0 otherwise. The provider always sends an
   * explicit budget on Gemini 3 so thinking cannot run unbounded.
   */
  thinkingBudget?: number
  /** Prefer native JSON outputs over prose when the active provider implements this. */
  structuredJson?: LLMStructuredJsonRequest
  /**
   * Opt-in reasoning stream. When provided, the provider enables model "thinking" and
   * streams the reasoning/thought tokens here as they are produced. Reasoning is **not**
   * the final answer — callers surface it as transient progress (a "loading bar") that
   * disappears once {@link LLMProvider.call} resolves with the real result.
   *
   * Passing this switches the provider to its streaming path; the returned
   * {@link LLMResponse} is reconstructed from the stream and is otherwise identical to a
   * non-streaming call. Providers that cannot stream reasoning fall back transparently.
   */
  onReasoning?: (delta: string) => void
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
