import type { EvidenceLabel } from '../core/evidence-label'
export type ConsumerIntent = 'query_truth'

export interface ConsumerIntentEnvelope {
  intent: ConsumerIntent
  requestId?: string
  payload: Record<string, unknown>
}

export interface IntentResult {
  status: 'accepted' | 'valid' | 'invalid' | 'uncertain' | 'error' | 'pending_review'
  explanation?: string
  recommendedAction?: string
  provenance?: string[]
  /** Categorical evidence strength from retrieval — see `core/evidence-label`. */
  evidence?: EvidenceLabel
  data?: unknown
  errorCode?: string
}

export interface RouteDecision {
  selectedOperation: string
  operationInput: Record<string, unknown>
  policyReason: string
}
