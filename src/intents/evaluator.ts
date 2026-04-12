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

export async function validateFact(
  toolExecutor: ToolExecutor,
  fact: string,
  domain?: string,
): Promise<IntentResult> {
  const query = domain ? `${domain} ${fact}` : fact
  const response = await toolExecutor.execute(
    createToolUse('read_documents', {
      query,
      mode: 'title',
      includeContent: true,
      limit: 5,
    }),
  )

  const results = ((response as { results?: Array<{ content?: string; metadata?: { id?: string } }> })
    .results ?? [])

  if (results.length === 0) {
    return {
      status: 'uncertain',
      confidence: 0.2,
      explanation: 'No supporting documents found for this fact.',
      recommendedAction: 'submit_fact',
      provenance: [],
    }
  }

  const supporting = results.filter(r => containsFact(r.content ?? '', fact))
  if (supporting.length === 0) {
    return {
      status: 'invalid',
      confidence: 0.8,
      explanation: 'Relevant documents found but none support the stated fact.',
      recommendedAction: 'dispute_fact',
      provenance: results.map(r => r.metadata?.id).filter(Boolean) as string[],
    }
  }

  const confidence = Math.min(0.95, 0.5 + supporting.length * 0.1)
  return {
    status: 'valid',
    confidence,
    explanation: 'Fact appears in relevant documents.',
    recommendedAction: 'none',
    provenance: supporting.map(r => r.metadata?.id).filter(Boolean) as string[],
  }
}

export async function disputeFact(
  toolExecutor: ToolExecutor,
  fact: string,
  because: string,
  domain?: string,
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

  const writeResult = await toolExecutor.execute(
    createToolUse('write_document', {
      title,
      content,
      tags: ['dispute', 'fact-check'],
      type: 'reference',
    }),
  ) as { id?: string }

  return {
    status: 'accepted',
    explanation: 'Dispute recorded for review and follow-up action.',
    recommendedAction: 'merge_documents',
    provenance: [writeResult.id ?? 'unknown-dispute-record'],
    confidence: 0.6,
  }
}
