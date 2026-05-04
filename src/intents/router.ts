import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest, LLMProvider } from '../core/types'
import { InvalidateOrchestrator } from '../tools/invalidate-orchestrator'
import { SubmitOrchestrator } from '../tools/submit-orchestrator'
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
    private readonly intentLlm?: LLMProvider,
    private readonly kbStorageDir?: string
  ) {}

  async route(intentEnvelope: ConsumerIntentEnvelope): Promise<RouteDecision> {
    const payload = intentEnvelope.payload

    switch (intentEnvelope.intent) {
      case 'submit_fact': {
        const fact = String(payload.fact ?? '').trim()
        const source = String(payload.source ?? 'consumer')

        if (!fact) {
          return {
            selectedOperation: 'validation_error',
            operationInput: payload,
            policyReason: 'fact is required',
          }
        }

        return {
          selectedOperation: 'submit_orchestrator',
          operationInput: { fact, source },
          policyReason: 'submit intent; discover best KB target via submit orchestrator',
        }
      }

      case 'invalidate_fact':
        return {
          selectedOperation: 'invalidate_orchestrator',
          operationInput: payload,
          policyReason:
            'invalidate intent; KB mutation via invalidate orchestrator (preview opt-in)',
        }

      case 'query_truth': {
        const queryText = String(payload.topic ?? payload.query ?? '')
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
            limit: effectiveLimit,
            type: payload.type,
            discoveryDepth: effectiveDiscoveryDepth,
            surface: payload.surface === 'chat' ? 'chat' : 'query',
          },
          policyReason: highRecall
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
    const payload = intentEnvelope.payload

    if (decision.selectedOperation === 'validation_error') {
      return {
        status: 'error',
        errorCode: 'INVALID_PAYLOAD_OR_INTENT',
        explanation: decision.policyReason,
      }
    }

    if (decision.selectedOperation === 'submit_orchestrator') {
      const fact = String(payload.fact ?? '').trim()
      const source = String(payload.source ?? 'consumer')
      const orchestrator = new SubmitOrchestrator(this.toolExecutor, this.intentLlm)
      const orchestratorResult = await orchestrator.run({ fact, source })

      return {
        status: 'accepted',
        explanation: `${decision.policyReason}; routed to ${orchestratorResult.targetDocId} (discovered=${orchestratorResult.discoveredTarget})`,
        recommendedAction: orchestratorResult.operation,
        data: orchestratorResult.result,
        provenance: extractProvenance(orchestratorResult.result),
        confidence: 0.8,
      }
    }

    if (decision.selectedOperation === 'invalidate_orchestrator') {
      const oldFact = String(payload.oldFact ?? payload.fact ?? '').trim()
      if (!oldFact) {
        return {
          status: 'error',
          errorCode: 'INVALID_PAYLOAD',
          explanation: 'invalidate_fact requires payload.oldFact or payload.fact',
        }
      }

      const orchestrator = new InvalidateOrchestrator(
        this.toolExecutor,
        this.intentLlm,
        this.kbStorageDir
      )
      return orchestrator.run({
        oldFact,
        replacementFact: asOptionalString(payload.replacementFact),
        preview: payload.preview === true,
        includeSessionLogs: payload.includeSessionLogs !== false,
      })
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
      confidence: 0.8,
    }
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
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
