import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import type { LLMProvider } from '../core/types'
import { assertSingleSentenceForSubmit } from '../core/sentence-split'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import { extractFactTriplet } from './triplet-extractor'

export interface SubmitOrchestratorInput {
  fact: string
  source: string
}

export interface SubmitOrchestratorResult {
  operation: 'fact_upserted'
  targetDocId: string
  discoveredTarget: false
  result: unknown
}

export class SubmitOrchestrator {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly llm?: LLMProvider
  ) {}

  async run(input: SubmitOrchestratorInput): Promise<SubmitOrchestratorResult> {
    const { fact, source } = input
    const sentence = assertSingleSentenceForSubmit(fact)
    const triplet = this.llm
      ? await extractFactTriplet(this.llm, sentence)
      : placeholderTripletFromFactText(sentence)

    const domain = inferDomainFromFact(sentence)
    const submission = await this.toolExecutor.execute(
      createToolUse('upsert_fact', {
        factText: sentence,
        triplet,
        sourceKind: 'submit',
        sourceRef: source,
        confidence: 0.8,
      })
    )
    const factId =
      typeof (submission as { id?: unknown }).id === 'string'
        ? (submission as { id: string }).id
        : `${domain}-fact`

    const graphSync = await this.toolExecutor.execute(
      createToolUse('upsert_graph_from_text', {
        text: sentence,
        documentId: factId,
      })
    )

    return {
      operation: 'fact_upserted',
      targetDocId: factId,
      discoveredTarget: false,
      result: {
        submission,
        graphSync,
      },
    }
  }
}

export function inferDomainFromFact(fact: string): string {
  const lower = fact.toLowerCase()

  const custom = matchCustomDomain(lower)
  if (custom) return custom

  const builtIn: Array<{ domain: string; pattern: RegExp }> = [
    { domain: 'cicd', pattern: /(cicd|pipeline|github actions|workflow|build|deploy|release)/ },
    {
      domain: 'security',
      pattern: /(security|vulnerability|auth|authentication|authorization|token|secret|oauth|rbac)/,
    },
    {
      domain: 'infra',
      pattern: /(kubernetes|k8s|docker|terraform|infrastructure|cluster|helm|container)/,
    },
    {
      domain: 'observability',
      pattern: /(monitoring|metrics|alerts|incident|on-call|pager|slo|sla|logs)/,
    },
    {
      domain: 'retrieval',
      pattern: /(retrieval|search|vector|embedding|index|rerank|fts|lane routing)/,
    },
  ]

  return builtIn.find(e => e.pattern.test(lower))?.domain ?? 'general'
}

function matchCustomDomain(normalizedFact: string): string | undefined {
  const raw = process.env.KB_DOMAIN_CLASSIFIER
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [domain, keywords] of Object.entries(parsed)) {
      if (!Array.isArray(keywords)) continue
      const tokens = keywords
        .filter((k): k is string => typeof k === 'string')
        .map(k => k.toLowerCase().trim())
        .filter(Boolean)
      if (tokens.some(t => normalizedFact.includes(t))) return normalizeDomain(domain)
    }
  } catch {
    // ignore
  }

  return undefined
}

function normalizeDomain(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'general'
  )
}

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return { id: `submit-${name}-${Date.now()}`, name, input }
}
