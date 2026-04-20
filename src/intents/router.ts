import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import { ValidateOrchestrator } from '../tools/validate-orchestrator'
import { ExplainOrchestrator } from '../tools/explain-orchestrator'
import { SubmitOrchestrator, inferDomainFromFact } from '../tools/submit-orchestrator'
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
  constructor(private toolExecutor: ToolExecutor) {}

  async route(intentEnvelope: ConsumerIntentEnvelope): Promise<RouteDecision> {
    const payload = intentEnvelope.payload

    switch (intentEnvelope.intent) {
      case 'submit_fact': {
        const fact = String(payload.fact ?? '').trim()
        const source = String(payload.source ?? 'consumer')
        const targetDocumentId =
          typeof payload.targetDocumentId === 'string' ? payload.targetDocumentId : undefined

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
          selectedOperation: 'submit_orchestrator',
          operationInput: { fact, source },
          policyReason: 'no targetDocumentId; discover best target via submit orchestrator',
        }
      }

      case 'validate_fact':
        return {
          selectedOperation: 'validate_orchestrator',
          operationInput: payload,
          policyReason: 'validate intent; discover evidence via validate orchestrator',
        }

      case 'query_truth': {
        const queryText = String(payload.topic ?? payload.query ?? '')
        const highRecall = requiresHighRecallQuery(queryText)
        const requestedLimit = typeof payload.limit === 'number' ? payload.limit : 5
        const effectiveLimit = highRecall ? Math.max(requestedLimit, 12) : requestedLimit
        const effectiveDiscoveryDepth = payload.discoveryDepth ?? (highRecall ? 'deep' : 'shallow')

        return {
          selectedOperation: 'read_documents',
          operationInput: {
            query: queryText,
            mode: 'content',
            includeContent: true,
            limit: effectiveLimit,
            type: payload.type,
            discoveryDepth: effectiveDiscoveryDepth,
          },
          policyReason: highRecall
            ? 'query intent maps to read_documents with high-recall evidence policy'
            : 'query intent maps directly to read_documents',
        }
      }

      case 'explain_change':
        return {
          selectedOperation: 'explain_orchestrator',
          operationInput: payload,
          policyReason: 'explain intent; id-first then semantic fallback via explain orchestrator',
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

    if (decision.selectedOperation === 'validate_orchestrator') {
      const fact = String(payload.fact ?? '').trim()
      if (!fact) {
        return {
          status: 'error',
          errorCode: 'INVALID_PAYLOAD',
          explanation: 'validate_fact requires payload.fact',
        }
      }
      const orchestrator = new ValidateOrchestrator(this.toolExecutor)
      return orchestrator.run({ fact, domain: asOptionalString(payload.domain) })
    }

    if (decision.selectedOperation === 'explain_orchestrator') {
      const changeId = String(payload.changeId ?? payload.fact ?? '').trim()
      if (!changeId) {
        return {
          status: 'error',
          errorCode: 'INVALID_PAYLOAD',
          explanation: 'explain_change requires payload.changeId or payload.fact',
        }
      }
      const orchestrator = new ExplainOrchestrator(this.toolExecutor)
      const result = await orchestrator.run({ changeId })
      return {
        status: 'accepted',
        explanation: decision.policyReason,
        recommendedAction: 'read_documents',
        data: result,
        provenance: result.results.map(r => r.metadata?.id).filter(Boolean) as string[],
        confidence: result.results.length > 0 ? 0.8 : 0.2,
      }
    }

    if (decision.selectedOperation === 'submit_orchestrator') {
      const fact = String(payload.fact ?? '').trim()
      const source = String(payload.source ?? 'consumer')
      const orchestrator = new SubmitOrchestrator(this.toolExecutor)
      const orchestratorResult = await orchestrator.run({ fact, source })

      if (intentEnvelope.intent === 'submit_fact') {
        const reconciliationOutcome = await maybeHandleSubmitContradictions(
          this.toolExecutor,
          payload,
          `${decision.policyReason}; routed to ${orchestratorResult.targetDocId} (discovered=${orchestratorResult.discoveredTarget})`,
          orchestratorResult.result
        )
        if (reconciliationOutcome) return reconciliationOutcome
      }

      return {
        status: 'accepted',
        explanation: `${decision.policyReason}; routed to ${orchestratorResult.targetDocId} (discovered=${orchestratorResult.discoveredTarget})`,
        recommendedAction: orchestratorResult.operation,
        data: orchestratorResult.result,
        provenance: extractProvenance(orchestratorResult.result),
        confidence: 0.8,
      }
    }

    if (decision.selectedOperation === 'upsert_fact_document') {
      const opInput = decision.operationInput
      const documentId = String(opInput.documentId ?? '').trim()
      const content = String(opInput.content ?? '').trim()
      const title = String(opInput.title ?? '').trim() || `${documentId} facts`
      const tags = Array.isArray(opInput.tags) ? opInput.tags : undefined
      const type = typeof opInput.type === 'string' ? opInput.type : undefined

      let toolResult: unknown
      try {
        toolResult = await this.toolExecutor.execute(
          createToolUse('append_to_document', { documentId, content })
        )
      } catch {
        toolResult = await this.toolExecutor.execute(
          createToolUse('write_document', { documentId, title, content, tags, type, overwrite: true })
        )
      }

      if (intentEnvelope.intent === 'submit_fact') {
        const reconciliationOutcome = await maybeHandleSubmitContradictions(
          this.toolExecutor,
          payload,
          decision.policyReason,
          toolResult
        )
        if (reconciliationOutcome) return reconciliationOutcome
      }

      return {
        status: 'accepted',
        explanation: decision.policyReason,
        recommendedAction: 'upsert_fact_document',
        data: toolResult,
        provenance: extractProvenance(toolResult),
        confidence: 0.8,
      }
    }

    const toolResult = await this.toolExecutor.execute(
      createToolUse(decision.selectedOperation, decision.operationInput)
    )

    if (intentEnvelope.intent === 'submit_fact') {
      const reconciliationOutcome = await maybeHandleSubmitContradictions(
        this.toolExecutor,
        payload,
        decision.policyReason,
        toolResult
      )
      if (reconciliationOutcome) return reconciliationOutcome
    }

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

async function maybeHandleSubmitContradictions(
  toolExecutor: ToolExecutor,
  payload: Record<string, unknown>,
  policyReason: string,
  submissionResult: unknown
): Promise<IntentResult | null> {
  const fact = typeof payload.fact === 'string' ? payload.fact.trim() : ''
  if (!fact) return null

  const domain = inferDomainFromFact(fact)
  const includeSessionLogs = payload.includeSessionLogs === true
  const reconciliationResult = (await toolExecutor.execute(
    createToolUse('reconcile_contradictions', {
      newFact: fact,
      domain,
      includeSessionLogs,
      dryRun: false,
    })
  )) as { changedDocumentIds?: string[]; removedFacts?: number }

  const changedDocumentIds = Array.isArray(reconciliationResult.changedDocumentIds)
    ? reconciliationResult.changedDocumentIds
    : []
  const removedFacts =
    typeof reconciliationResult.removedFacts === 'number' ? reconciliationResult.removedFacts : 0

  return {
    status: 'accepted',
    explanation: `${policyReason}; contradiction reconciliation removed ${removedFacts} conflicting fact line${removedFacts === 1 ? '' : 's'}`,
    recommendedAction: 'reconcile_contradictions',
    data: {
      submission: submissionResult,
      contradictionReconciliation: reconciliationResult,
    },
    provenance: [...extractProvenance(submissionResult), ...changedDocumentIds],
    confidence: 0.8,
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
