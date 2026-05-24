import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, ToolUseRequest } from '../core/types'
import type { ConsumerIntentEnvelope, IntentResult, RouteDecision } from './types'

export interface IntentRouter {
  route(intent: ConsumerIntentEnvelope): Promise<RouteDecision>
  execute(intent: ConsumerIntentEnvelope): Promise<IntentResult>
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return {
    id: `intent-${name}-${dayjs().valueOf()}`,
    name,
    input,
  }
}

export class DefaultIntentRouter implements IntentRouter {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    _intentLlm?: LLMProvider,
    _kbStorageDir?: string
  ) {}

  async route(intentEnvelope: ConsumerIntentEnvelope): Promise<RouteDecision> {
    const payload = intentEnvelope.payload

    switch (intentEnvelope.intent) {
      case 'query_truth': {
        const queryText = String(payload.topic ?? payload.query ?? '')
        const allFacts = payload.allFacts === true
        const highRecall = requiresHighRecallQuery(queryText)
        const requestedLimit = typeof payload.limit === 'number' ? payload.limit : 5
        const effectiveLimit = highRecall ? Math.max(requestedLimit, 12) : requestedLimit
        const effectiveDiscoveryDepth = payload.discoveryDepth ?? 'deep'

        return {
          selectedOperation: 'read_facts',
          operationInput: {
            query: queryText,
            mode: 'content',
            includeContent: true,
            limit: allFacts ? 99999 : effectiveLimit,
            type: payload.type,
            discoveryDepth: allFacts ? 'shallow' : effectiveDiscoveryDepth,
            surface: payload.surface === 'chat' ? 'chat' : 'query',
            excludeIds: Array.isArray(payload.excludeIds) ? payload.excludeIds : undefined,
            ...(allFacts ? { allFacts: true } : {}),
          },
          policyReason: allFacts
            ? 'query intent with --all-facts: load all KB facts without query expansion'
            : highRecall
              ? 'query intent maps to read_facts with high-recall evidence policy'
              : 'query intent maps directly to read_facts',
        }
      }

      default:
        return {
          selectedOperation: 'validation_error',
          operationInput: payload,
          policyReason: `unsupported intent: ${(intentEnvelope as { intent?: string }).intent ?? 'unknown'}`,
        }
    }
  }

  async execute(intentEnvelope: ConsumerIntentEnvelope): Promise<IntentResult> {
    const decision = await this.route(intentEnvelope)

    if (decision.selectedOperation === 'validation_error') {
      return {
        status: 'error',
        errorCode: 'INVALID_PAYLOAD_OR_INTENT',
        explanation: decision.policyReason,
      }
    }

    const toolResult = await this.toolExecutor.execute(
      createToolUse(decision.selectedOperation, decision.operationInput)
    )

    return {
      status: 'accepted',
      explanation: decision.policyReason,
      recommendedAction: decision.selectedOperation,
      data: toolResult,
      provenance: extractProvenance(toolResult),
      confidence: deriveToolResultConfidence(toolResult),
    }
  }
}

function requiresHighRecallQuery(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  if (/^[A-Z0-9._-]{16,}$/.test(trimmed)) return true
  if (trimmed.length >= 20 && (trimmed.includes('_') || trimmed.includes('-'))) return true
  return false
}

function extractProvenance(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const id = (result as { id?: string }).id
  if (id) return [id]
  const results = (result as { results?: Array<{ metadata?: { id?: string } }> }).results
  if (Array.isArray(results)) {
    return results.map(r => r.metadata?.id).filter(Boolean) as string[]
  }
  return []
}

function deriveToolResultConfidence(result: unknown): number {
  if (!result || typeof result !== 'object') return 0.8
  const checkpoints = (
    result as {
      retrieval?: { checkpoints?: Array<{ confidence?: number }> }
    }
  ).retrieval?.checkpoints
  const lastConfidence = checkpoints?.[checkpoints.length - 1]?.confidence
  if (typeof lastConfidence === 'number' && Number.isFinite(lastConfidence)) {
    return Math.max(0, Math.min(1, lastConfidence))
  }
  return 0.8
}
