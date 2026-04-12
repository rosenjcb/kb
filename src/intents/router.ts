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
        const domain = resolveFactDomain(payload.domain, fact)
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
          selectedOperation: 'upsert_fact_document',
          operationInput: {
            documentId: `${domain}-facts`,
            title: `${domain} facts`,
            content: `- ${fact} (source: ${source})`,
            tags: [domain, 'fact'],
            type: 'reference',
          },
          policyReason: 'no targetDocumentId; upsert into inferred domain fact document',
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
            // Auto mode allows ID-first lookup with semantic/content fallback.
            includeContent: true,
            limit: 3,
          },
          policyReason: 'explain intent reads change/fact context with id-first + semantic fallback',
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
          createToolUse('append_to_document', {
            documentId,
            content,
          }),
        )
      } catch {
        toolResult = await this.toolExecutor.execute(
          createToolUse('write_document', {
            documentId,
            title,
            content,
            tags,
            type,
            overwrite: true,
          }),
        )
      }

      if (intentEnvelope.intent === 'submit_fact') {
        const reconciliationOutcome = await maybeHandleSubmitContradictions(
          this.toolExecutor,
          payload,
          decision.policyReason,
          toolResult,
        )
        if (reconciliationOutcome) {
          return reconciliationOutcome
        }
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
      createToolUse(decision.selectedOperation, decision.operationInput),
    )

    if (intentEnvelope.intent === 'submit_fact') {
      const reconciliationOutcome = await maybeHandleSubmitContradictions(
        this.toolExecutor,
        payload,
        decision.policyReason,
        toolResult,
      )
      if (reconciliationOutcome) {
        return reconciliationOutcome
      }
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
  submissionResult: unknown,
): Promise<IntentResult | null> {
  const fact = typeof payload.fact === 'string' ? payload.fact.trim() : ''
  if (!fact) return null

  const domain = resolveFactDomain(payload.domain, fact)
  const includeSessionLogs = payload.includeSessionLogs === true
  const reconciliationResult = await toolExecutor.execute(
    createToolUse('reconcile_contradictions', {
      newFact: fact,
      domain,
      includeSessionLogs,
      dryRun: false,
    }),
  ) as { changedDocumentIds?: string[]; removedFacts?: number }

  const changedDocumentIds = Array.isArray(reconciliationResult.changedDocumentIds)
    ? reconciliationResult.changedDocumentIds
    : []

  const removedFacts = typeof reconciliationResult.removedFacts === 'number'
    ? reconciliationResult.removedFacts
    : 0

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

function resolveFactDomain(domainValue: unknown, fact: string): string {
  if (typeof domainValue === 'string' && domainValue.trim()) {
    return normalizeDomain(domainValue)
  }

  const normalizedFact = fact.toLowerCase()

  const customDomain = matchCustomDomain(normalizedFact)
  if (customDomain) {
    return customDomain
  }

  const builtIn: Array<{ domain: string; pattern: RegExp }> = [
    { domain: 'cicd', pattern: /(cicd|pipeline|github actions|workflow|build|deploy|release)/ },
    { domain: 'security', pattern: /(security|vulnerability|auth|authentication|authorization|token|secret|oauth|rbac)/ },
    { domain: 'infra', pattern: /(kubernetes|k8s|docker|terraform|infrastructure|cluster|helm|container)/ },
    { domain: 'observability', pattern: /(monitoring|metrics|alerts|incident|on-call|pager|slo|sla|logs)/ },
    { domain: 'retrieval', pattern: /(retrieval|search|vector|embedding|index|rerank|fts|lane routing)/ },
  ]

  const matched = builtIn.find(entry => entry.pattern.test(normalizedFact))
  return matched?.domain ?? 'general'
}

function matchCustomDomain(normalizedFact: string): string | undefined {
  const raw = process.env.KB_DOMAIN_CLASSIFIER
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [domain, keywords] of Object.entries(parsed)) {
      if (!Array.isArray(keywords)) continue
      const tokens = keywords
        .filter(keyword => typeof keyword === 'string')
        .map(keyword => keyword.toLowerCase().trim())
        .filter(Boolean)

      if (tokens.some(token => normalizedFact.includes(token))) {
        return normalizeDomain(domain)
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

function normalizeDomain(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general'
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
