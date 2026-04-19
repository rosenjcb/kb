import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'

export interface ExplainOrchestratorInput {
  changeId: string
}

export interface ExplainOrchestratorResult {
  results: Array<{ content?: string; metadata?: { id?: string } }>
  total: number
  retrieval: {
    method: string
    detail?: string
  }
}

export class ExplainOrchestrator {
  constructor(private readonly toolExecutor: ToolExecutor) {}

  async run(input: ExplainOrchestratorInput): Promise<ExplainOrchestratorResult> {
    const { changeId } = input

    // Phase 1: ID-first lookup — treat the input as a doc ID or exact phrase
    const idResult = await this.probe(changeId, undefined, 3)
    if (idResult.results.length > 0) {
      return idResult
    }

    // Phase 2: Semantic content search (shallow)
    const shallow = await this.probe(changeId, 'content', 5)
    if (shallow.results.length >= 2) {
      return shallow
    }

    // Phase 3: Deep discovery for complex / multi-concept queries
    const deep = await this.probe(changeId, 'content', 8, 'deep')
    if (deep.results.length > 0) {
      return deep
    }

    // Return whatever shallow found (may be empty)
    return shallow
  }

  private async probe(
    query: string,
    mode: 'content' | undefined,
    limit: number,
    discoveryDepth: 'shallow' | 'deep' = 'shallow'
  ): Promise<ExplainOrchestratorResult> {
    try {
      const input: Record<string, unknown> = {
        query,
        includeContent: true,
        limit,
        discoveryDepth,
      }
      if (mode) input.mode = mode

      const response = (await this.toolExecutor.execute(
        createToolUse('read_documents', input)
      )) as {
        results?: Array<{ content?: string; metadata?: { id?: string } }>
        total?: number
        retrieval?: { method?: string; detail?: string }
      }

      return {
        results: response.results ?? [],
        total: response.total ?? 0,
        retrieval: {
          method: response.retrieval?.method ?? 'unknown',
          detail: response.retrieval?.detail,
        },
      }
    } catch {
      return { results: [], total: 0, retrieval: { method: 'error' } }
    }
  }
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return { id: `explain-${name}-${Date.now()}`, name, input }
}
