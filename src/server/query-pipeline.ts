/**
 * Transport-agnostic query pipeline.
 *
 * This is the single retrieval-and-synthesis code path shared by the CLI
 * (`kb query`) and the server (`kb server start`). It mirrors the intent branch
 * in `src/cli/index.ts` but without any printer / spinner / telemetry coupling so
 * it can run inside an HTTP request or an MCP tool call.
 */

import { DatabaseSync } from 'node:sqlite'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import { expandQueryWithGraph, kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { llmExtractQueryEntities, rerankByGraphConnectivity } from '../tools/graph-rag-reranker.js'
import { formatGraphRelationBlockFromQuestion } from '../tools/graph-relation-context.js'
import type { KbConfig } from '../cli/kb-config.js'
import { resolveFactRetrievalMethod } from '../cli/kb-config.js'
import {
  enrichReadDocumentsAnswerWithLLM,
  getIntentQuestion,
  isReadFactsResult,
  type ParsedIntentCommand,
  type ReadDocumentsResultData,
} from '../cli/intent-cli.js'
import { runQueryTruthRetrieval } from '../cli/query-truth-retrieval.js'

export interface QueryPipelineDeps {
  toolExecutor: ToolExecutor
  llmProvider?: LLMProvider
  /** Active KB base directory (holds `.kb-index.sqlite`). */
  baseDir: string
  config: KbConfig
}

export interface QueryPipelineParams {
  query: string
  limit?: number
  type?: string
  discovery?: 'shallow' | 'deep'
  verbose?: boolean
  /**
   * When false, skip the LLM answer-synthesis step and return retrieved facts only.
   * MCP clients (which do their own reasoning) default to false; the REST API defaults to true.
   */
  synthesize?: boolean
}

/**
 * Run the full `query_truth` pipeline: graph expansion → retrieval → graph-RAG
 * rerank → optional LLM answer synthesis. Returns the raw `IntentResult`; callers
 * serialize it for their transport.
 *
 * Unlike the CLI path this never reads `query-session.json` (servers are stateless),
 * never auto-syncs, and never mutates persistent session state.
 */
export async function runQueryPipeline(
  deps: QueryPipelineDeps,
  params: QueryPipelineParams
): Promise<IntentResult> {
  const { toolExecutor, llmProvider, baseDir, config } = deps
  const query = params.query.trim()
  if (!query) {
    throw new Error('query is required')
  }

  const allFacts = resolveFactRetrievalMethod(config) === 'all_facts'

  const payload: Record<string, unknown> = {
    query,
    limit: params.limit,
    type: params.type,
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
  }

  // Capture the pre-expansion question so synthesis/scaffold use the user's words,
  // not the graph-expanded retrieval payload.
  const synthesisQuestion = getIntentQuestion(parsed).trim() || query

  // Graph augmentation (best-effort): expand the retrieval query with neighboring
  // concepts and capture a relation-path block for relational questions.
  let graphRelationContext: string | undefined
  if (!allFacts) {
    try {
      const db = new DatabaseSync(kbIndexDbPath(baseDir), { readOnly: true })
      try {
        ;(parsed.envelope.payload as { query?: string }).query = expandQueryWithGraph(query, db)
        try {
          const block = formatGraphRelationBlockFromQuestion(db, query)
          if (block) graphRelationContext = block
        } catch {
          // Relation-path block is best-effort; never block the query.
        }
      } finally {
        db.close()
      }
    } catch {
      // Graph augmentation unavailable; fall back to plain retrieval.
    }
  }

  let aligned = await runQueryTruthRetrieval({
    parsed,
    toolExecutor,
    llmProvider,
    kbStorageDir: baseDir,
  })

  // LLM-driven graph RAG: extract entities from the question, re-rank retrieved
  // facts by graph connectivity.
  if (llmProvider && isReadFactsResult(aligned) && !allFacts) {
    try {
      const entities = await llmExtractQueryEntities(query, llmProvider)
      if (entities.length > 0) {
        const db = new DatabaseSync(kbIndexDbPath(baseDir), { readOnly: true })
        try {
          const data = (aligned.data ?? {}) as ReadDocumentsResultData
          const reranked = rerankByGraphConnectivity(
            Array.isArray(data.results) ? data.results : [],
            entities,
            db
          )
          aligned = { ...aligned, data: { ...data, results: reranked } }
        } finally {
          db.close()
        }
      }
    } catch {
      // Re-ranking is best-effort; never block the answer.
    }
  }

  const shouldSynthesize = params.synthesize !== false
  if (shouldSynthesize && llmProvider && isReadFactsResult(aligned)) {
    return enrichReadDocumentsAnswerWithLLM(parsed, aligned, llmProvider, undefined, undefined, {
      graphRelationContext,
      synthesisQuestion,
    })
  }

  return aligned
}
