import {
  type EvidenceLabel,
  assessResultCount,
  isEvidenceAtLeast,
} from '../core/evidence-label'

export type RetrievalCheckpointStage = 'hybrid_primary' | 'lexical_recovery' | 'query_rewrite_retry'

export type RetrievalCheckpointStatus = 'hit' | 'miss' | 'error'

export interface RetrievalCheckpointRecord {
  stage: RetrievalCheckpointStage
  status: RetrievalCheckpointStatus
  /** How much usable evidence this stage produced. Categorical — see `core/evidence-label`. */
  evidence: EvidenceLabel
  reason: string
  nextAction: 'return' | 'advance'
  method: 'hybrid' | 'lexical' | 'lexical-fallback'
  detail?: string
}

/**
 * How much evidence a stage must produce before the pipeline stops advancing.
 * The primary stage is held to a higher bar than the recovery stages, which is
 * the entire distinction the old `highConfidenceThreshold` / `mediumConfidenceThreshold`
 * pair encoded — as two floats that had to be compared against a third.
 */
export interface RetrievalCheckpointConfig {
  primaryStageFloor: EvidenceLabel
  recoveryStageFloor: EvidenceLabel
}

const DEFAULT_CONFIG: RetrievalCheckpointConfig = {
  primaryStageFloor: 'weak',
  recoveryStageFloor: 'weak',
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

  const evidence = assessResultCount(input.totalResults)
  const status = input.status ?? (input.totalResults > 0 ? 'hit' : 'miss')
  const nextAction = decideNextAction(input.stage, status, evidence, config)

  return {
    stage: input.stage,
    status,
    evidence,
    reason: input.reason,
    nextAction,
    method: input.method,
    detail: input.detail,
  }
}

function decideNextAction(
  stage: RetrievalCheckpointStage,
  status: RetrievalCheckpointStatus,
  evidence: EvidenceLabel,
  config: RetrievalCheckpointConfig
): 'return' | 'advance' {
  if (stage === 'query_rewrite_retry') {
    return 'return'
  }

  if (status === 'error' || status === 'miss') {
    return 'advance'
  }

  const floor =
    stage === 'hybrid_primary' ? config.primaryStageFloor : config.recoveryStageFloor
  return isEvidenceAtLeast(evidence, floor) ? 'return' : 'advance'
}
