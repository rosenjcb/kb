import { type EvidenceLabel, isEvidenceLabel } from '../core/evidence-label'
import dayjs from 'dayjs'
import type { RunCollector } from '../core/telemetry'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, ToolUseRequest } from '../core/types'
import { DEFAULT_FACT_LIMIT } from '../tools/hybrid-retriever'
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

const DEFAULT_FACT_RETRIEVAL_LIMIT = DEFAULT_FACT_LIMIT

export class DefaultIntentRouter implements IntentRouter {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    _intentLlm?: LLMProvider,
    _kbStorageDir?: string,
    private readonly collector?: RunCollector
  ) {}

  async route(intentEnvelope: ConsumerIntentEnvelope): Promise<RouteDecision> {
    const payload = intentEnvelope.payload

    switch (intentEnvelope.intent) {
      case 'query_truth': {
        const queryText = String(payload.topic ?? payload.query ?? '')
        const allFacts = payload.allFacts === true
        const effectiveLimit =
          typeof payload.limit === 'number' ? payload.limit : DEFAULT_FACT_RETRIEVAL_LIMIT
        const effectiveDiscoveryDepth = payload.discoveryDepth ?? 'deep'

        return {
          selectedOperation: 'read_facts',
          operationInput: {
            query: queryText,
            mode: 'content',
            includeContent: true,
            limit: allFacts ? 99999 : effectiveLimit,
            discoveryDepth: allFacts ? 'shallow' : effectiveDiscoveryDepth,
            surface: payload.surface === 'chat' ? 'chat' : 'query',
            excludeIds: Array.isArray(payload.excludeIds) ? payload.excludeIds : undefined,
            ...(allFacts ? { allFacts: true } : {}),
            ...(this.collector ? { collector: this.collector } : {}),
          },
          policyReason: allFacts
            ? 'query intent with --all-facts: load all KB facts without query expansion'
            : 'query intent maps to read_facts',
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
      evidence: deriveToolResultEvidence(toolResult),
    }
  }
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

/**
 * Carry the last retrieval checkpoint's evidence label onto the intent result.
 * A tool result that reports no checkpoints (a non-retrieval intent) is treated
 * as `strong` — it did the work it was asked to do; there is nothing weak about it.
 */
function deriveToolResultEvidence(result: unknown): EvidenceLabel {
  if (!result || typeof result !== 'object') return 'strong'
  const checkpoints = (
    result as {
      retrieval?: { checkpoints?: Array<{ evidence?: unknown }> }
    }
  ).retrieval?.checkpoints
  const last = checkpoints?.[checkpoints.length - 1]?.evidence
  return isEvidenceLabel(last) ? last : 'strong'
}
