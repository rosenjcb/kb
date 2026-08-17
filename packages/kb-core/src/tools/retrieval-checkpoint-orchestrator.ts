import {
  type EvidenceLabel,
  assessResultCount,
  assessRetrievalEvidence,
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
  /**
   * Mean top-unit cosine relevance in `[0, 1]`, when the stage measured it. Present → the label is
   * the relevance-aware `assessRetrievalEvidence`; absent → it falls back to a bare result count.
   * This is what lets a stage that returned 3 low-relevance results score below one that returned
   * 3 strong ones, instead of both being unconditionally `strong` (#219).
   */
  avgTop?: number
  /** Share of query concepts covered by the kept set, paired with `avgTop`. Defaults to 0. */
  conceptCoverage?: number
}): RetrievalCheckpointRecord {
  const config: RetrievalCheckpointConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
  }

  const evidence =
    typeof input.avgTop === 'number'
      ? assessRetrievalEvidence({
          uniqueFacts: input.totalResults,
          avgTop: input.avgTop,
          conceptCoverage: input.conceptCoverage ?? 0,
        })
      : assessResultCount(input.totalResults)
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
