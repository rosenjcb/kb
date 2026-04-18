/**
 * Intent Loop — generic multi-iteration harness for all intent commands.
 *
 * Wraps DefaultIntentRouter.execute() with:
 *   - Discovery escalation for query/explain (shallow → deep on weak retrieval)
 *   - LLM semantic reasoning for validate when token-overlap is inconclusive
 *   - Carryover of confidence, provenance, and retrieval depth across iterations
 *
 * submit_fact and dispute_fact are single-pass — no retry logic applies.
 */

import dayjs from 'dayjs'
import type { LLMProvider } from './types'
import type { ToolExecutor } from './tool-registry'
import type { RunCollector } from './telemetry'
import { estimateCost } from './telemetry'
import type { ConsumerIntentEnvelope, IntentResult } from '../intents/types'
import { DefaultIntentRouter } from '../intents/router'

export interface IntentLoopConfig {
  /** Maximum number of iterations. Default: 3. */
  maxIterations?: number
  /** Stop early when confidence reaches this threshold. Default: 0.7. */
  confidenceThreshold?: number
  /** Enables LLM semantic reasoning pass for uncertain validate results. */
  provider?: LLMProvider
  /** Telemetry collector — records per-iteration StageMetrics. */
  collector?: RunCollector
}

export interface IntentLoopResult {
  result: IntentResult
  /** Number of router.execute() calls made. */
  iterations: number
  /** True if any iteration escalated discovery depth or applied LLM reasoning. */
  escalated: boolean
}

export async function runIntentLoop(
  envelope: ConsumerIntentEnvelope,
  toolExecutor: ToolExecutor,
  config: IntentLoopConfig = {},
): Promise<IntentLoopResult> {
  const maxIterations = config.maxIterations ?? 3
  const confidenceThreshold = config.confidenceThreshold ?? 0.7
  const router = new DefaultIntentRouter(toolExecutor)

  const { collector } = config
  const providerName = config.provider?.name ?? 'gemini'
  const providerModel = config.provider?.model ?? 'unknown'

  const executeWithTelemetry = async (env: ConsumerIntentEnvelope, stageSuffix: string): Promise<IntentResult> => {
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
        estimatedCostUsd: estimateCost(providerName, providerModel, usage.inputTokens, usage.outputTokens),
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

    // Single-pass intents — no retry
    if (intent === 'submit_fact' || intent === 'dispute_fact') break

    // Already good enough
    if ((result.confidence ?? 0) >= confidenceThreshold) break

    // Errors are terminal
    if (result.status === 'error') break

    if (intent === 'validate_fact') {
      // Docs found but token-overlap inconclusive → try LLM semantic reasoning
      if (result.status === 'uncertain' && result.confidence === 0.45 && config.provider) {
        const llmStartMs = Date.now()
        const llmStartedAt = dayjs().toISOString()
        const llmResult = await applyLLMValidationReasoning(
          toolExecutor,
          String(envelope.payload.fact ?? ''),
          config.provider,
        )
        if (llmResult) {
          result = llmResult
          iterations++
          escalated = true
          if (collector) {
            const usage = extractUsageFromResult(llmResult)
            collector.addStage({
              stage: `${intent}:llm-reasoning`,
              startedAt: llmStartedAt,
              durationMs: Date.now() - llmStartMs,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimatedCostUsd: estimateCost(providerName, providerModel, usage.inputTokens, usage.outputTokens),
              provider: providerName,
              model: providerModel,
            })
          }
        }
        break
      }

      // No docs at all (confidence 0.2) — nothing to reason over, stop
      break
    }

    if (intent === 'query_truth' || intent === 'explain_change') {
      if (!hasWeakRetrieval(result)) break

      const refined = escalateQueryEnvelope(currentEnvelope)
      if (refined === currentEnvelope) break // already at deep, can't escalate further

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

// ─── Usage extraction ─────────────────────────────────────────────────────────

function extractUsageFromResult(result: IntentResult): { inputTokens: number; outputTokens: number } {
  const data = result.data as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined
  return {
    inputTokens: data?.usage?.inputTokens ?? 0,
    outputTokens: data?.usage?.outputTokens ?? 0,
  }
}

// ─── Retrieval quality ────────────────────────────────────────────────────────

function hasWeakRetrieval(result: IntentResult): boolean {
  const data = result.data as {
    results?: unknown[]
    retrieval?: { checkpoints?: Array<{ status?: string }> }
  } | undefined

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
  if (envelope.payload.discoveryDepth === 'deep') return envelope // already maxed

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

// ─── LLM validation reasoning ─────────────────────────────────────────────────

/**
 * Called when validate returns uncertain/0.45: docs exist but token-overlap failed.
 * Re-fetches evidence with deep discovery and asks the LLM for a semantic judgment.
 * Returns null if the LLM is uncertain or the call fails, so the caller keeps the
 * original result.
 */
async function applyLLMValidationReasoning(
  toolExecutor: ToolExecutor,
  fact: string,
  provider: LLMProvider,
): Promise<IntentResult | null> {
  try {
    const response = await toolExecutor.execute({
      id: `intent-loop-validate-${dayjs().valueOf()}`,
      name: 'read_documents',
      input: {
        query: fact,
        mode: 'content',
        includeContent: true,
        limit: 8,
        discoveryDepth: 'deep',
      },
    }) as { results?: Array<{ content?: string; metadata?: { id?: string } }>; retrieval?: unknown }

    const results = Array.isArray(response.results) ? response.results : []
    if (results.length === 0) return null

    const evidence = results
      .slice(0, 4)
      .map((r, i) => {
        const id = r.metadata?.id ?? `doc-${i + 1}`
        return `Document ${i + 1} (${id}):\n${(r.content ?? '').slice(0, 600)}`
      })
      .join('\n\n')

    const completion = await provider.call({
      messages: [
        {
          role: 'user',
          content: [
            'You are a fact-checker. Given KB evidence, determine if the following fact is supported.',
            'Reply with exactly one of: SUPPORTED, NOT_SUPPORTED, or UNCERTAIN.',
            'Follow it with a one-sentence explanation.',
            '',
            `Fact: ${fact}`,
            '',
            `Evidence:\n${evidence}`,
          ].join('\n'),
        },
      ],
      temperature: 0.0,
      maxTokens: 512,
    })

    const text = completion.text.trim()
    const upper = text.toUpperCase()
    const provenance = results.map(r => r.metadata?.id).filter(Boolean) as string[]
    const explanation = extractExplanationLine(text)

    if (upper.startsWith('SUPPORTED')) {
      return {
        status: 'valid',
        confidence: 0.72,
        explanation: `Fact validated via LLM semantic reasoning over ${results.length} KB documents.${explanation ? ` ${explanation}` : ''}`,
        recommendedAction: 'none',
        provenance,
        data: { retrieval: response.retrieval, llmReasoning: true },
      }
    }

    if (upper.startsWith('NOT_SUPPORTED')) {
      return {
        status: 'uncertain',
        confidence: 0.3,
        explanation: `LLM reasoning found no KB support for this fact.${explanation ? ` ${explanation}` : ''} Consider: kb submit "<fact>".`,
        recommendedAction: 'submit_fact',
        provenance,
        data: { retrieval: response.retrieval, llmReasoning: true },
      }
    }

    // UNCERTAIN — preserve the original result
    return null
  } catch {
    return null
  }
}

function extractExplanationLine(text: string): string {
  const verdict = /^(SUPPORTED|NOT_SUPPORTED|UNCERTAIN)\b/i
  const line = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .find(l => !verdict.test(l))
  return line ?? ''
}
