import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import type { IntentResult } from '../intents/types'

export interface ValidateOrchestratorInput {
  fact: string
  domain?: string
}

type ReadResult = {
  results: Array<{ content?: string; metadata?: { id?: string } }>
  retrieval?: { method?: string; detail?: string }
}

export class ValidateOrchestrator {
  constructor(private readonly toolExecutor: ToolExecutor) {}

  async run(input: ValidateOrchestratorInput): Promise<IntentResult> {
    const { fact, domain } = input
    const query = domain ? `${domain} ${fact}` : fact

    // Phase 1: shallow probe
    const shallow = await this.probe(query, 'shallow', 5)
    let effective = shallow
    let deepUsed = false

    const shallowSupport = shallow.results.filter(r => this.supports(r.content ?? '', fact))

    // Phase 2: escalate to deep if shallow found nothing useful
    if (shallow.results.length === 0 || shallowSupport.length === 0) {
      const deep = await this.probe(query, 'deep', 12)
      if (deep.results.length > 0) {
        effective = deep
        deepUsed = true
      }
    }

    const retrievalText = describeRetrieval(effective.retrieval)

    if (effective.results.length === 0) {
      return {
        status: 'uncertain',
        confidence: 0.2,
        explanation: `No supporting documents found for this fact. ${retrievalText}`,
        recommendedAction: 'submit_fact',
        provenance: [],
        data: { retrieval: effective.retrieval, evidencePolicy: { shallowCount: shallow.results.length, deepUsed, finalCount: 0 } },
      }
    }

    const supporting = effective.results.filter(r => this.supports(r.content ?? '', fact))

    if (supporting.length === 0) {
      return {
        status: 'uncertain',
        confidence: 0.45,
        explanation: `Relevant documents were found, but support is inconclusive after evidence discovery. ${retrievalText}`,
        recommendedAction: 'query_truth',
        provenance: effective.results.map(r => r.metadata?.id).filter(Boolean) as string[],
        data: { retrieval: effective.retrieval, evidencePolicy: { shallowCount: shallow.results.length, deepUsed, finalCount: effective.results.length } },
      }
    }

    const confidence = Math.min(0.95, 0.5 + supporting.length * 0.1)
    return {
      status: 'valid',
      confidence,
      explanation: `${deepUsed ? 'Fact support confirmed after deep evidence discovery. ' : 'Fact appears in relevant documents. '}${retrievalText}`,
      recommendedAction: 'none',
      provenance: supporting.map(r => r.metadata?.id).filter(Boolean) as string[],
      data: { retrieval: effective.retrieval, evidencePolicy: { shallowCount: shallow.results.length, deepUsed, finalCount: effective.results.length } },
    }
  }

  private async probe(query: string, discoveryDepth: 'shallow' | 'deep', limit: number): Promise<ReadResult> {
    try {
      const response = await this.toolExecutor.execute(
        createToolUse('read_documents', { query, mode: 'content', includeContent: true, limit, discoveryDepth })
      ) as ReadResult
      return { results: response.results ?? [], retrieval: response.retrieval }
    } catch {
      return { results: [] }
    }
  }

  private supports(text: string, fact: string): boolean {
    if (text.toLowerCase().includes(fact.toLowerCase())) return true
    const factTokens = tokenize(fact)
    if (factTokens.length === 0) return false
    const textSet = new Set(tokenize(text))
    let overlap = 0
    for (const t of factTokens) if (textSet.has(t)) overlap++
    return overlap >= 3 || overlap / factTokens.length >= 0.5
  }
}

function tokenize(text: string): string[] {
  const stop = new Set(['the','a','an','and','or','to','of','in','on','for','with','by','is','are','was','were','be','being','been','that','this','it','as','at','from','our','your','their','fact','facts','about'])
  return text.toLowerCase().replace(/[^a-z0-9\s._-]/g, ' ').split(/\s+/).map(t => t.trim()).filter(t => t.length >= 3 && !stop.has(t))
}

function describeRetrieval(r: { method?: string; detail?: string } | undefined): string {
  if (!r?.method) return 'Retrieval method: unknown.'
  return r.detail ? `Retrieval method: ${r.method} (${r.detail}).` : `Retrieval method: ${r.method}.`
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return { id: `validate-${name}-${Date.now()}`, name, input }
}
