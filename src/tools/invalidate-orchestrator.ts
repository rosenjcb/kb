import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import type { IntentResult } from '../intents/types'

export interface InvalidateOrchestratorInput {
  oldFact: string
  replacementFact?: string
  preview?: boolean
  dryRun?: boolean
  includeSessionLogs?: boolean
}

interface InvalidateToolResult {
  changes?: Array<{ documentId?: string }>
  summary?: string
  error?: string
}

export class InvalidateOrchestrator {
  constructor(private readonly toolExecutor: ToolExecutor) {}

  async run(input: InvalidateOrchestratorInput): Promise<IntentResult> {
    const preview = input.preview !== false
    const dryRun = input.dryRun === true

    const result = (await this.toolExecutor.execute(
      createToolUse('invalidate_fact', {
        oldFact: input.oldFact,
        replacementFact: input.replacementFact,
        preview,
        dryRun,
        includeSessionLogs: input.includeSessionLogs !== false,
      })
    )) as InvalidateToolResult

    const changedDocIds = Array.isArray(result.changes)
      ? result.changes
          .map(change => (typeof change.documentId === 'string' ? change.documentId.trim() : ''))
          .filter(Boolean)
      : []

    if (!preview && !dryRun && changedDocIds.length > 0) {
      await this.toolExecutor.execute(
        createToolUse('invalidate_graph_documents', {
          documentIds: changedDocIds,
        })
      )
    }

    const summary = result.summary ?? 'No KB documents changed.'
    const suffix =
      !preview && !dryRun && changedDocIds.length > 0
        ? ` Graph invalidation applied to ${changedDocIds.length} document provenance entr${changedDocIds.length === 1 ? 'y' : 'ies'}.`
        : ''

    return {
      status: result.error && changedDocIds.length === 0 ? 'uncertain' : 'accepted',
      explanation: `${summary}${suffix}`.trim(),
      recommendedAction: preview || dryRun ? 'preview_invalidation' : 'invalidate_fact',
      data: {
        ...result,
        invalidatedGraphDocumentIds: !preview && !dryRun ? changedDocIds : [],
      },
      provenance: changedDocIds,
      confidence: changedDocIds.length > 0 ? 0.8 : 0.3,
    }
  }
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return { id: `invalidate-${name}-${Date.now()}`, name, input }
}
