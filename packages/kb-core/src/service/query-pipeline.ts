/**
 * Transport-agnostic query pipeline.
 *
 * This is the single retrieval-and-synthesis code path shared by the CLI
 * (`kb query`) and the server (`kb-server start`). It mirrors the intent branch
 * in `src/cli/index.ts` but without any printer / spinner / telemetry coupling so
 * it can run inside an HTTP request or an MCP tool call.
 */

import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider } from '@kb/core/core/types.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import {
  type RunCollector,
  TokenCountingProvider,
  estimateCost,
  summarizeQueryRetrievalTrace,
} from '@kb/core/core/telemetry.js'
import { type LLMFailure, toLLMFailure } from '@kb/core/core/llm-error.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import { isKbIndexEmpty } from '@kb/core/tools/sqlite-kb-index.js'
import { basename } from 'node:path'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { resolveFactRetrievalMethod } from '@kb/core/config/kb-config.js'
import {
  enrichReadDocumentsAnswerWithLLM,
  getIntentQuestion,
  isReadFactsResult,
  type ParsedIntentCommand,
  type ReadDocumentsResultData,
} from '@kb/core/query/intent-cli.js'
import { runQueryTruthRetrieval } from '@kb/core/query/query-truth-retrieval.js'
import { inferQueryScope, type ScopeVerdict } from '@kb/core/query/scope-inference.js'
import { buildInquiryLanes } from '@kb/core/query/inquiry-lanes.js'

export interface QueryPipelineDeps {
  toolExecutor: ToolExecutor
  llmProvider?: LLMProvider
  /** Active KB base directory (holds `.kb-index.sqlite`). */
  baseDir: string
  config: KbConfig
}

export interface QueryPipelineParams {
  query: string
  discovery?: 'shallow' | 'deep'
  verbose?: boolean
  /**
   * When false, skip the LLM answer-synthesis step and return retrieved facts only.
   * MCP clients (which do their own reasoning) default to false; the REST API defaults to true.
   */
  synthesize?: boolean
  /** Opt-in deep query trace (`kb query --trace`). */
  trace?: boolean
  /** When set, LLM token usage is recorded on the collector (server / telemetry paths). */
  collector?: RunCollector
}

/**
 * Run the full `query_truth` pipeline: scope inference → hybrid retrieval → optional LLM
 * answer synthesis. Returns the raw `IntentResult`; callers serialize it for their transport.
 *
 * Unlike the CLI path this never reads `query-session.json` (servers are stateless),
 * never auto-syncs, and never mutates persistent session state.
 */
export async function runQueryPipeline(
  deps: QueryPipelineDeps,
  params: QueryPipelineParams
): Promise<IntentResult> {
  const { toolExecutor, llmProvider: rawLlmProvider, baseDir, config } = deps
  const query = params.query.trim()
  if (!query) {
    throw new Error('query is required')
  }

  // An empty base (no repos indexed yet — the default base before anyone adds one) has
  // nothing to retrieve. Answer with a clear, actionable message instead of running the
  // pipeline over an empty index and returning a hollow "no evidence" answer.
  if (isKbIndexEmpty(kbIndexDbPath(baseDir))) {
    const baseName = basename(baseDir)
    return {
      status: 'uncertain',
      evidence: 'none',
      explanation: `This base ("${baseName}") is empty — no repositories have been indexed yet.`,
      recommendedAction: `An operator can add one on the server: \`kb-server base add-repo ${baseName} --git <url>\`.`,
    }
  }

  const llmCounter =
    rawLlmProvider && params.collector ? new TokenCountingProvider(rawLlmProvider) : undefined
  const llmProvider = llmCounter ?? rawLlmProvider

  const recordLlmStage = (stage: string, durationMs: number, startedAt: string) => {
    if (!params.collector || !llmCounter || !llmProvider) return
    const tokens = llmCounter.getAndReset()
    if (tokens.inputTokens === 0 && tokens.outputTokens === 0) return
    params.collector.addStage({
      stage,
      startedAt,
      durationMs,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      estimatedCostUsd: estimateCost(
        llmProvider.name,
        llmProvider.model,
        tokens.inputTokens,
        tokens.outputTokens
      ),
      provider: llmProvider.name,
      model: llmProvider.model,
    })
  }

  const allFacts = resolveFactRetrievalMethod(config) === 'all_facts'

  const payload: Record<string, unknown> = {
    query,
    discoveryDepth: params.discovery,
  }
  if (allFacts) payload.allFacts = true

  const parsed: ParsedIntentCommand = {
    envelope: {
      intent: 'query_truth',
      requestId: `req-${Date.now()}`,
      payload,
    },
    verbose: params.verbose,
    allFacts,
    trace: params.trace,
  }

  const prevTraceEnv = process.env.KB_QUERY_TRACE
  if (params.trace) {
    process.env.KB_QUERY_TRACE = 'true'
  }

  try {
  // Capture the pre-expansion question so synthesis/scaffold use the user's words,
  // not the graph-expanded retrieval payload.
  const synthesisQuestion = getIntentQuestion(parsed).trim() || query

  // Stage 0 — scope inference (best-effort): infer which entity (service /
  // surface / domain) the question is about before any fuzzy retrieval runs.
  // Inert when the registry is empty, unresolved, or KB_ENTITY_SCOPE=false.
  // Best-effort stages that failed on an LLM error. Never block the query, never silent.
  const degraded: LLMFailure[] = []

  let scope: ScopeVerdict | undefined
  if (!allFacts) {
    try {
      const verdict = await inferQueryScope({
        dbPath: kbIndexDbPath(baseDir),
        query,
        ...(llmProvider ? { llm: llmProvider } : {}),
      })
      if (!verdict.unresolved) scope = verdict
    } catch (error) {
      // Scope inference is best-effort; never block the query. But a failure here means the
      // answer may silently be about the wrong entity *and* the disclosure line that would
      // have exposed that is missing — so it gets recorded.
      degraded.push(toLLMFailure('scope-inference', error, llmProvider?.name))
    }
  }

  // Entity-guarded expansion (best-effort): when scope resolved, the entity's own aliases
  // widen the retrieval query. There is no generic graph widening fallback — that path
  // pulled colliding neighborhoods into the query string, and the hybrid retriever's
  // lexical + neural lanes cover the recall it was there for.
  let graphRelationContext: string | undefined
  if (!allFacts && scope?.expansionTerms && scope.expansionTerms.length > 0) {
    const extra = scope.expansionTerms
      .filter(term => !query.toLowerCase().includes(term.toLowerCase()))
      .slice(0, 8)
    ;(parsed.envelope.payload as { query?: string }).query = [query, ...extra].join(' ')
  }

  // Ontology-typed inquiry lanes: turn the resolved entity into targeted sub-queries
  // (its owner, its parent, its dependencies, kind-appropriate mechanism probes)
  // rather than letting the reader guess facets from the question string. Reuses the
  // stage-0 verdict, so lane targets match the scope disclosure the user is shown.
  // Deterministic and additive — no lanes means the reader's existing path runs.
  let inquiryLaneCount = 0
  if (!allFacts) {
    try {
      const lanes = buildInquiryLanes({
        dbPath: kbIndexDbPath(baseDir),
        query,
        ...(scope ? { verdict: scope } : {}),
      })
      inquiryLaneCount = lanes.length
      if (lanes.length > 0) {
        ;(parsed.envelope.payload as { inquiryLanes?: unknown }).inquiryLanes = lanes
      }
    } catch {
      // Lane construction is best-effort; never block the query.
    }
  }

  // Hard pruning under the confidence gates: exclusions are only ever fact ids
  // linked to `certainly_incorrect` entities (unlinked facts are never prunable).
  const appliedExclusions = scope !== undefined && scope.excludedFactIds.length > 0
  if (appliedExclusions && scope) {
    ;(parsed.envelope.payload as { excludeIds?: string[] }).excludeIds = scope.excludedFactIds
  }

  let aligned = await runQueryTruthRetrieval({
    parsed,
    toolExecutor,
    llmProvider,
    kbStorageDir: baseDir,
    collector: params.collector,
  })

  // Un-pruning safety valve: a wrong scope verdict costs a retry, never the
  // answer. If pruned retrieval came back empty, lift exclusions and re-run.
  if (appliedExclusions && isReadFactsResult(aligned)) {
    const data = (aligned.data ?? {}) as ReadDocumentsResultData
    const resultCount = Array.isArray(data.results) ? data.results.length : 0
    if (resultCount === 0) {
      ;(parsed.envelope.payload as { excludeIds?: string[] }).excludeIds = undefined
      aligned = await runQueryTruthRetrieval({
        parsed,
        toolExecutor,
        llmProvider,
        kbStorageDir: baseDir,
        collector: params.collector,
      })
    }
  }

  // Disclose the interpretation to synthesis — always, whenever resolution
  // happened. Silent disambiguation is how trust dies.
  if (scope?.disclosure) {
    const disclosureBlock = `Scope interpretation: ${scope.disclosure}`
    graphRelationContext = graphRelationContext
      ? `${disclosureBlock}\n\n${graphRelationContext}`
      : disclosureBlock
  }

  // Fold pipeline-level degradations in with any recorded during retrieval, so every
  // best-effort LLM failure for this query arrives on one channel.
  if (degraded.length > 0 && isReadFactsResult(aligned)) {
    const data = (aligned.data ?? {}) as ReadDocumentsResultData
    aligned = {
      ...aligned,
      data: {
        ...data,
        retrieval: {
          ...data.retrieval,
          degraded: [...(data.retrieval?.degraded ?? []), ...degraded],
        },
      },
    }
  }

  // Stamp scope/lane counters onto the retrieval detail the client prints and
  // the eval harness scrapes — not only the collector's structured trace.
  if (isReadFactsResult(aligned)) {
    const data = (aligned.data ?? {}) as ReadDocumentsResultData
    if (data.retrieval) {
      aligned = {
        ...aligned,
        data: {
          ...data,
          retrieval: annotateScopeDetail(data.retrieval, scope, inquiryLaneCount),
        },
      }
    }
  }

  const shouldSynthesize = params.synthesize !== false
  if (shouldSynthesize && llmProvider && isReadFactsResult(aligned)) {
    const enrichStarted = Date.now()
    const enrichStartedAt = new Date().toISOString()
    const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, aligned, llmProvider, undefined, undefined, {
      graphRelationContext,
      synthesisQuestion,
    })
    recordLlmStage('query_truth:answer-enrichment', Date.now() - enrichStarted, enrichStartedAt)
    if (params.collector && isReadFactsResult(enriched)) {
      const retrievalData = (enriched.data as ReadDocumentsResultData | undefined)?.retrieval
      if (retrievalData) {
        params.collector.setRetrievalTrace(summarizeQueryRetrievalTrace(retrievalData))
      }
    }
    return enriched
  }

  if (params.collector && isReadFactsResult(aligned)) {
    const retrievalData = (aligned.data as ReadDocumentsResultData | undefined)?.retrieval
    if (retrievalData) {
      params.collector.setRetrievalTrace(summarizeQueryRetrievalTrace(retrievalData))
    }
  }

  return aligned
  } finally {
    if (params.trace) {
      if (prevTraceEnv === undefined) process.env.KB_QUERY_TRACE = undefined
      else process.env.KB_QUERY_TRACE = prevTraceEnv
    }
  }
}

/** Append landed entity + lane count onto retrieval.detail for eval / --debug. */
function annotateScopeDetail(
  retrieval: NonNullable<ReadDocumentsResultData['retrieval']>,
  scope: ScopeVerdict | undefined,
  laneCount: number
): NonNullable<ReadDocumentsResultData['retrieval']> {
  const landings =
    scope?.candidates
      .filter(c => c.label === 'very_confident' || c.label === 'confident')
      .map(c => c.entity.canonicalName) ?? []
  const bits = [
    landings.length > 0 ? `scope:${landings.join('+')}` : 'scope:none',
    `lanes:${laneCount}`,
  ]
  const detail = [retrieval.detail, ...bits].filter(Boolean).join(';')
  return { ...retrieval, detail }
}
