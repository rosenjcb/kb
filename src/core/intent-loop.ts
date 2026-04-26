/**
 * Intent Loop — generic multi-iteration harness for KB intent commands.
 *
 * Wraps DefaultIntentRouter.execute() with:
 *   - Discovery escalation for query (shallow → deep on weak retrieval)
 *   - Carryover of confidence, provenance, and retrieval depth across iterations
 *
 * submit_fact and invalidate_fact are single-pass — no retry logic applies.
 */

import dayjs from 'dayjs'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntentEnvelope, IntentResult } from '../intents/types'
import type { RunCollector } from './telemetry'
import { estimateCost } from './telemetry'
import type { ToolExecutor } from './tool-registry'
import type { LLMProvider } from './types'

const DEFAULT_INTENT_LOOP_MAX_ITERATIONS = parseEnvInt('KB_INTENT_LOOP_MAX_ITERATIONS', 3)
const DEFAULT_INTENT_LOOP_CONFIDENCE_THRESHOLD = parseEnvFloat(
  'KB_INTENT_LOOP_CONFIDENCE_THRESHOLD',
  0.7
)

export interface IntentLoopConfig {
  /** Maximum number of iterations. Default: 3. */
  maxIterations?: number
  /** Stop early when confidence reaches this threshold. Default: 0.7. */
  confidenceThreshold?: number
  /** Optional provider used by callers that also collect token telemetry. */
  provider?: LLMProvider
  /** Telemetry collector — records per-iteration StageMetrics. */
  collector?: RunCollector
}

export interface IntentLoopResult {
  result: IntentResult
  /** Number of router.execute() calls made. */
  iterations: number
  /** True if any iteration escalated discovery depth. */
  escalated: boolean
}

export async function runIntentLoop(
  envelope: ConsumerIntentEnvelope,
  toolExecutor: ToolExecutor,
  config: IntentLoopConfig = {}
): Promise<IntentLoopResult> {
  const maxIterations = config.maxIterations ?? DEFAULT_INTENT_LOOP_MAX_ITERATIONS
  const confidenceThreshold =
    config.confidenceThreshold ?? DEFAULT_INTENT_LOOP_CONFIDENCE_THRESHOLD
  const router = new DefaultIntentRouter(toolExecutor)

  const { collector } = config
  const providerName = config.provider?.name ?? 'gemini'
  const providerModel = config.provider?.model ?? 'unknown'

  const executeWithTelemetry = async (
    env: ConsumerIntentEnvelope,
    stageSuffix: string
  ): Promise<IntentResult> => {
    const startMs = Date.now()
    const startedAt = dayjs().toISOString()
    const res = await router.execute(env)
    const durationMs = Date.now() - startMs

    if (collector) {
      const usage = extractUsageFromResult(res)
      collector.addStage({
        stage: `${env.intent}:${stageSuffix}`,
        startedAt,
        durationMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: estimateCost(
          providerName,
          providerModel,
          usage.inputTokens,
          usage.outputTokens
        ),
        provider: providerName,
        model: providerModel,
      })
    }

    return res
  }

  let currentEnvelope = envelope
  let result = await executeWithTelemetry(currentEnvelope, 'iter1')
  let iterations = 1
  let escalated = false

  while (iterations < maxIterations) {
    const intent = envelope.intent

    if (intent === 'submit_fact' || intent === 'invalidate_fact') break
    if ((result.confidence ?? 0) >= confidenceThreshold) break
    if (result.status === 'error') break

    if (intent === 'query_truth') {
      if (!hasWeakRetrieval(result)) break

      const refined = escalateQueryEnvelope(currentEnvelope)
      if (refined === currentEnvelope) break

      currentEnvelope = refined
      escalated = true
      iterations++
      result = await executeWithTelemetry(currentEnvelope, `iter${iterations}`)
      continue
    }

    break
  }

  return { result, iterations, escalated }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback
  return parsed
}

function extractUsageFromResult(result: IntentResult): {
  inputTokens: number
  outputTokens: number
} {
  const data = result.data as
    | { usage?: { inputTokens?: number; outputTokens?: number } }
    | undefined
  return {
    inputTokens: data?.usage?.inputTokens ?? 0,
    outputTokens: data?.usage?.outputTokens ?? 0,
  }
}

function hasWeakRetrieval(result: IntentResult): boolean {
  const data = result.data as
    | {
        results?: unknown[]
        retrieval?: { checkpoints?: Array<{ status?: string }> }
      }
    | undefined

  if (!data) return true

  const count = Array.isArray(data.results) ? data.results.length : 0
  if (count === 0) return true

  const checkpoints = data.retrieval?.checkpoints
  if (Array.isArray(checkpoints) && checkpoints.length > 0) {
    const last = checkpoints[checkpoints.length - 1]
    if (last.status === 'miss' || last.status === 'error') return true
  }

  return count < 2
}

function escalateQueryEnvelope(envelope: ConsumerIntentEnvelope): ConsumerIntentEnvelope {
  if (envelope.payload.discoveryDepth === 'deep') return envelope

  const currentLimit = typeof envelope.payload.limit === 'number' ? envelope.payload.limit : 5
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      discoveryDepth: 'deep',
      limit: Math.min(currentLimit * 2, 20),
    },
  }
}
