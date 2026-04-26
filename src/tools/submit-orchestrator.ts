import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'

export interface SubmitOrchestratorInput {
  fact: string
  source: string
}

export interface SubmitOrchestratorResult {
  operation: 'appended' | 'upserted'
  targetDocId: string
  discoveredTarget: boolean
  result: unknown
}

export class SubmitOrchestrator {
  constructor(private readonly toolExecutor: ToolExecutor) {}

  async run(input: SubmitOrchestratorInput): Promise<SubmitOrchestratorResult> {
    const { fact, source } = input
    const bulletLine = `- ${fact} (source: ${source})`

    const candidate = await this.discoverTarget(fact)
    let targetDocId: string
    let discoveredTarget: boolean
    let operation: SubmitOrchestratorResult['operation']
    let submission: unknown

    if (candidate) {
      targetDocId = candidate.docId
      discoveredTarget = true
      operation = 'appended'
      submission = await this.toolExecutor.execute(
        createToolUse('append_to_document', {
          documentId: candidate.docId,
          content: bulletLine,
        })
      )
    } else {
      const domain = inferDomainFromFact(fact)
      const docId = `${domain}-facts`
      targetDocId = docId
      discoveredTarget = false
      operation = 'upserted'

      try {
        submission = await this.toolExecutor.execute(
          createToolUse('append_to_document', { documentId: docId, content: bulletLine })
        )
      } catch {
        submission = await this.toolExecutor.execute(
          createToolUse('write_document', {
            documentId: docId,
            title: `${domain} facts`,
            content: bulletLine,
            tags: [domain, 'fact'],
            type: 'reference',
            overwrite: true,
          })
        )
      }
    }

    const graphSync = await this.toolExecutor.execute(
      createToolUse('upsert_graph_from_text', {
        text: fact,
        documentId: targetDocId,
      })
    )

    return {
      operation,
      targetDocId,
      discoveredTarget,
      result: {
        submission,
        graphSync,
      },
    }
  }

  private async discoverTarget(fact: string): Promise<{ docId: string } | null> {
    // Use the first 300 chars as the discovery query — key terms lead
    const discoveryQuery = fact.slice(0, 300)

    let response: {
      results?: Array<{ metadata?: { id?: string } }>
      retrieval?: { method?: string }
    }

    try {
      response = (await this.toolExecutor.execute(
        createToolUse('read_documents', {
          query: discoveryQuery,
          mode: 'content',
          discoveryDepth: 'shallow',
          includeContent: false,
          limit: 3,
        })
      )) as typeof response
    } catch {
      return null
    }

    const results = response.results ?? []
    const method = response.retrieval?.method

    // Only trust hybrid matches — lexical-fallback hits are too loose for write targeting
    if (method === 'hybrid' && results.length > 0) {
      const docId = results[0].metadata?.id
      if (docId) return { docId }
    }

    return null
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
