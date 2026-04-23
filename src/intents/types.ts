export type ConsumerIntent =
  | 'submit_fact'
  | 'query_truth'
  | 'invalidate_fact'

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
  confidence?: number
  data?: unknown
  errorCode?: string
}

export interface RouteDecision {
  selectedOperation: string
  operationInput: Record<string, unknown>
  policyReason: string
}
