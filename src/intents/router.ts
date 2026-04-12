import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import { disputeFact, validateFact } from './evaluator'
import type {
  ConsumerIntentEnvelope,
  IntentResult,
  RouteDecision,
} from './types'

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
  constructor(private toolExecutor: ToolExecutor) {}

  async route(intentEnvelope: ConsumerIntentEnvelope): Promise<RouteDecision> {
    const payload = intentEnvelope.payload

    switch (intentEnvelope.intent) {
      case 'submit_fact': {
        const fact = String(payload.fact ?? '').trim()
        const domain = String(payload.domain ?? 'general')
        const source = String(payload.source ?? 'consumer')
        const targetDocumentId = typeof payload.targetDocumentId === 'string'
          ? payload.targetDocumentId
          : undefined

        if (!fact) {
          return {
            selectedOperation: 'validation_error',
            operationInput: payload,
            policyReason: 'fact is required',
          }
        }

        if (targetDocumentId) {
          return {
            selectedOperation: 'append_to_document',
            operationInput: {
              documentId: targetDocumentId,
              content: `- ${fact} (source: ${source})`,
            },
            policyReason: 'targetDocumentId provided; append to existing document',
          }
        }

        return {
          selectedOperation: 'write_document',
          operationInput: {
            title: `${domain} facts`,
            content: `- ${fact} (source: ${source})`,
            tags: [domain, 'fact'],
            type: 'reference',
          },
          policyReason: 'no targetDocumentId; create/write into domain fact document',
        }
      }

      case 'validate_fact':
        return {
          selectedOperation: 'validate_fact_evaluator',
          operationInput: payload,
          policyReason: 'validation intent requires fact evaluator logic',
        }

      case 'dispute_fact':
        return {
          selectedOperation: 'dispute_fact_evaluator',
          operationInput: payload,
          policyReason: 'dispute intent requires dispute evaluator logic',
        }

      case 'query_truth':
        return {
          selectedOperation: 'read_documents',
          operationInput: {
            query: payload.topic ?? payload.query ?? '',
            mode: 'content',
            includeContent: true,
            limit: payload.limit ?? 5,
            type: payload.type,
          },
          policyReason: 'query intent maps directly to read_documents',
        }

      case 'explain_change':
        return {
          selectedOperation: 'read_documents',
          operationInput: {
            query: payload.changeId ?? payload.fact ?? '',
            mode: 'id',
            includeContent: true,
            limit: 1,
          },
          policyReason: 'explain intent reads change/fact record and returns context',
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

    if (decision.selectedOperation === 'validate_fact_evaluator') {
      const fact = String(payload.fact ?? '').trim()
      if (!fact) {
        return {
          status: 'error',
          errorCode: 'INVALID_PAYLOAD',
          explanation: 'validate_fact requires payload.fact',
        }
      }
      return validateFact(this.toolExecutor, fact, asOptionalString(payload.domain))
    }

    if (decision.selectedOperation === 'dispute_fact_evaluator') {
      const fact = String(payload.fact ?? '').trim()
      const because = String(payload.because ?? '').trim()
      if (!fact || !because) {
        return {
          status: 'error',
          errorCode: 'INVALID_PAYLOAD',
          explanation: 'dispute_fact requires payload.fact and payload.because',
        }
      }
      return disputeFact(this.toolExecutor, fact, because, asOptionalString(payload.domain))
    }

    const toolResult = await this.toolExecutor.execute(
      createToolUse(decision.selectedOperation, decision.operationInput),
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
