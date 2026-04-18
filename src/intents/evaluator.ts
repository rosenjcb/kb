import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import type { IntentResult } from './types'

function createToolUse(name: string, input: Record<string, unknown>): ToolUseRequest {
  return {
    id: `intent-${name}-${dayjs().valueOf()}`,
    name,
    input,
  }
}

function containsFact(text: string, fact: string): boolean {
  return text.toLowerCase().includes(fact.toLowerCase())
}

function tokenize(text: string): string[] {
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'by',
    'is',
    'are',
    'was',
    'were',
    'be',
    'being',
    'been',
    'that',
    'this',
    'it',
    'as',
    'at',
    'from',
    'our',
    'your',
    'their',
    'fact',
    'facts',
    'about',
  ])

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .filter(token => !stopwords.has(token))
}

function hasSemanticSupport(text: string, fact: string): boolean {
  const factTokens = tokenize(fact)
  if (factTokens.length === 0) return false

  const textTokenSet = new Set(tokenize(text))
  let overlap = 0
  for (const token of factTokens) {
    if (textTokenSet.has(token)) overlap += 1
  }

  const ratio = overlap / factTokens.length
  return overlap >= 3 || ratio >= 0.5
}

async function readFactEvidence(
  toolExecutor: ToolExecutor,
  query: string,
  discoveryDepth: 'shallow' | 'deep',
  limit: number
): Promise<{
  results: Array<{ content?: string; metadata?: { id?: string } }>
  retrieval?: { method?: string; detail?: string }
}> {
  const response = await toolExecutor.execute(
    createToolUse('read_documents', {
      query,
      mode: 'content',
      includeContent: true,
      limit,
      discoveryDepth,
    })
  )

  const typedResponse = response as {
    results?: Array<{ content?: string; metadata?: { id?: string } }>
    retrieval?: { method?: string; detail?: string }
  }

  return {
    results: typedResponse.results ?? [],
    retrieval: typedResponse.retrieval,
  }
}

export async function validateFact(
  toolExecutor: ToolExecutor,
  fact: string,
  domain?: string
): Promise<IntentResult> {
  const query = domain ? `${domain} ${fact}` : fact
  const shallow = await readFactEvidence(toolExecutor, query, 'shallow', 5)
  let effectiveResults = shallow.results
  let effectiveRetrieval = shallow.retrieval
  let deepUsed = false

  const shallowSupporting = shallow.results.filter(r => {
    const content = r.content ?? ''
    return containsFact(content, fact) || hasSemanticSupport(content, fact)
  })

  if (shallow.results.length === 0 || shallowSupporting.length === 0) {
    const deep = await readFactEvidence(toolExecutor, query, 'deep', 12)
    if (deep.results.length > 0) {
      effectiveResults = deep.results
      effectiveRetrieval = deep.retrieval
      deepUsed = true
    }
  }

  const retrievalText = describeRetrieval(effectiveRetrieval)

  if (effectiveResults.length === 0) {
    return {
      status: 'uncertain',
      confidence: 0.2,
      explanation: `No supporting documents found for this fact. ${retrievalText}`,
      recommendedAction: 'submit_fact',
      provenance: [],
      data: {
        retrieval: effectiveRetrieval,
        evidencePolicy: {
          shallowCount: shallow.results.length,
          deepUsed,
          finalCount: effectiveResults.length,
        },
      },
    }
  }

  const supporting = effectiveResults.filter(r => {
    const content = r.content ?? ''
    return containsFact(content, fact) || hasSemanticSupport(content, fact)
  })

  if (supporting.length === 0) {
    return {
      status: 'uncertain',
      confidence: 0.45,
      explanation: `Relevant documents were found, but support is inconclusive after evidence discovery. ${retrievalText}`,
      recommendedAction: 'query_truth',
      provenance: effectiveResults.map(r => r.metadata?.id).filter(Boolean) as string[],
      data: {
        retrieval: effectiveRetrieval,
        evidencePolicy: {
          shallowCount: shallow.results.length,
          deepUsed,
          finalCount: effectiveResults.length,
        },
      },
    }
  }

  const confidence = Math.min(0.95, 0.5 + supporting.length * 0.1)
  return {
    status: 'valid',
    confidence,
    explanation: `${deepUsed ? 'Fact support confirmed after deep evidence discovery. ' : 'Fact appears in relevant documents. '}${retrievalText}`,
    recommendedAction: 'none',
    provenance: supporting.map(r => r.metadata?.id).filter(Boolean) as string[],
    data: {
      retrieval: effectiveRetrieval,
      evidencePolicy: {
        shallowCount: shallow.results.length,
        deepUsed,
        finalCount: effectiveResults.length,
      },
    },
  }
}

export async function disputeFact(
  toolExecutor: ToolExecutor,
  fact: string,
  because: string,
  domain?: string
): Promise<IntentResult> {
  const validateResult = await validateFact(toolExecutor, fact, domain)

  if (validateResult.status === 'invalid') {
    return {
      status: 'accepted',
      explanation: 'Dispute accepted. Current KB evidence already contradicts this fact.',
      recommendedAction: 'update_document',
      provenance: validateResult.provenance,
      confidence: validateResult.confidence,
    }
  }

  // Create a dispute note in KB for traceability.
  const title = `Dispute: ${fact.slice(0, 50)}`
  const content = [
    `Fact: ${fact}`,
    `Reason: ${because}`,
    `RecordedAt: ${dayjs().toISOString()}`,
    validateResult.explanation ? `ValidationContext: ${validateResult.explanation}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const writeResult = (await toolExecutor.execute(
    createToolUse('write_document', {
      title,
      content,
      tags: ['dispute', 'fact-check'],
      type: 'reference',
    })
  )) as { id?: string }

  return {
    status: 'accepted',
    explanation: 'Dispute recorded for review and follow-up action.',
    recommendedAction: 'merge_documents',
    provenance: [writeResult.id ?? 'unknown-dispute-record'],
    confidence: 0.6,
  }
}

function describeRetrieval(retrieval: { method?: string; detail?: string } | undefined): string {
  if (!retrieval?.method) return 'Retrieval method: unknown.'
  if (!retrieval.detail) return `Retrieval method: ${retrieval.method}.`
  return `Retrieval method: ${retrieval.method} (${retrieval.detail}).`
}
