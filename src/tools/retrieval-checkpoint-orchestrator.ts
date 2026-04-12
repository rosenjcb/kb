export type RetrievalCheckpointStage =
  | 'hybrid_primary'
  | 'lexical_recovery'
  | 'query_rewrite_retry'

export type RetrievalCheckpointStatus = 'hit' | 'miss' | 'error'

export interface RetrievalCheckpointRecord {
  stage: RetrievalCheckpointStage
  status: RetrievalCheckpointStatus
  confidence: number
  reason: string
  nextAction: 'return' | 'advance'
  method: 'hybrid' | 'lexical' | 'lexical-fallback'
  detail?: string
}

export interface RetrievalCheckpointConfig {
  highConfidenceThreshold: number
  mediumConfidenceThreshold: number
}

const DEFAULT_CONFIG: RetrievalCheckpointConfig = {
  highConfidenceThreshold: 0.55,
  mediumConfidenceThreshold: 0.45,
}

export function estimateConfidence(totalResults: number): number {
  if (totalResults <= 0) return 0
  if (totalResults === 1) return 0.55
  if (totalResults === 2) return 0.72
  return 0.86
}

export function buildCheckpointRecord(input: {
  stage: RetrievalCheckpointStage
  totalResults: number
  method: 'hybrid' | 'lexical' | 'lexical-fallback'
  detail?: string
  reason: string
  status?: RetrievalCheckpointStatus
  config?: Partial<RetrievalCheckpointConfig>
}): RetrievalCheckpointRecord {
  const config: RetrievalCheckpointConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
  }

  const confidence = estimateConfidence(input.totalResults)
  const status = input.status ?? (input.totalResults > 0 ? 'hit' : 'miss')
  const nextAction = decideNextAction(input.stage, status, confidence, config)

  return {
    stage: input.stage,
    status,
    confidence,
    reason: input.reason,
    nextAction,
    method: input.method,
    detail: input.detail,
  }
}

function decideNextAction(
  stage: RetrievalCheckpointStage,
  status: RetrievalCheckpointStatus,
  confidence: number,
  config: RetrievalCheckpointConfig,
): 'return' | 'advance' {
  if (stage === 'query_rewrite_retry') {
    return 'return'
  }

  if (status === 'error' || status === 'miss') {
    return 'advance'
  }

  if (stage === 'hybrid_primary') {
    return confidence >= config.highConfidenceThreshold ? 'return' : 'advance'
  }

  return confidence >= config.mediumConfidenceThreshold ? 'return' : 'advance'
}