import path from 'node:path'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import { assertSingleSentenceForSubmit } from '../core/sentence-split'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import type { LLMProvider } from '../core/types'
import type { IntentResult } from '../intents/types'
import { locateFactRowFromNaturalLanguage } from './fact-locate-from-nl'
import type { FactTriplet } from './sqlite-kb-index'
import { SqliteKbIndexer } from './sqlite-kb-index'
import { extractFactTriplet } from './triplet-extractor'

export interface InvalidateOrchestratorInput {
  oldFact: string
  replacementFact?: string
  preview?: boolean
  includeSessionLogs?: boolean
}

interface InvalidateToolResult {
  changes?: Array<{ factId?: string }>
  summary?: string
  error?: string
}

export class InvalidateOrchestrator {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly llm?: LLMProvider,
    private readonly kbStorageDir?: string
  ) {}

  async run(input: InvalidateOrchestratorInput): Promise<IntentResult> {
    const preview = input.preview === true

    let canonicalOld = String(input.oldFact ?? '').trim()
    if (!canonicalOld) {
      return {
        status: 'error',
        errorCode: 'INVALID_PAYLOAD',
        explanation: 'invalidate_fact requires payload.oldFact or payload.fact',
      }
    }

    if (this.kbStorageDir) {
      const indexer = new SqliteKbIndexer({
        dbPath: path.join(this.kbStorageDir, '.kb-index.sqlite'),
      })
      try {
        const row = await locateFactRowFromNaturalLanguage({
          indexer,
          userText: canonicalOld,
          llm: this.llm,
        })
        if (!row) {
          return {
            status: 'error',
            errorCode: 'NO_FACT_MATCH',
            explanation:
              'No fact matched that description. Try `kb facts search` or pass the exact fact sentence or fact id.',
          }
        }
        canonicalOld = row.fact_text
      } finally {
        indexer.close()
      }
    }

    let replacementTriplet: FactTriplet | undefined
    const rep = input.replacementFact?.trim()
    if (rep) {
      const sentence = assertSingleSentenceForSubmit(rep)
      replacementTriplet = this.llm
        ? await extractFactTriplet(this.llm, sentence)
        : placeholderTripletFromFactText(sentence)
    }

    const result = (await this.toolExecutor.execute(
      createToolUse('invalidate_fact', {
        oldFact: canonicalOld,
        replacementFact: input.replacementFact,
        replacementTriplet,
        preview,
        includeSessionLogs: input.includeSessionLogs !== false,
      })
    )) as InvalidateToolResult

    const changedDocIds = Array.isArray(result.changes)
      ? result.changes
          .map(change => (typeof change.factId === 'string' ? change.factId.trim() : ''))
          .filter(Boolean)
      : []

    if (!preview && changedDocIds.length > 0) {
      await this.toolExecutor.execute(
        createToolUse('invalidate_graph_for_fact', {
          documentIds: changedDocIds,
        })
      )
    }

    const summary = result.summary ?? 'No facts changed.'
    const suffix =
      !preview && changedDocIds.length > 0
        ? ` Graph invalidation applied to ${changedDocIds.length} fact provenance entr${changedDocIds.length === 1 ? 'y' : 'ies'}.`
        : ''

    return {
      status: result.error && changedDocIds.length === 0 ? 'uncertain' : 'accepted',
      explanation: `${summary}${suffix}`.trim(),
      recommendedAction: preview ? 'preview_invalidation' : 'invalidate_fact',
      data: {
        ...result,
        invalidatedGraphDocumentIds: !preview ? changedDocIds : [],
      },
      provenance: changedDocIds,
      confidence: changedDocIds.length > 0 ? 0.8 : 0.3,
    }
  }
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return { id: `invalidate-${name}-${Date.now()}`, name, input }
}
