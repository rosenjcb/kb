import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider } from '../core/types'
import { assertConsumerSafeCommand } from '../intents/policy'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntent, ConsumerIntentEnvelope, IntentResult } from '../intents/types'

export type CliOutputMode = 'human' | 'json'

export interface ParsedIntentCommand {
  envelope: ConsumerIntentEnvelope
  output: CliOutputMode
}

const INTENT_COMMANDS = new Set(['submit', 'validate', 'dispute', 'query', 'explain'])

export function isIntentCommand(command: string): boolean {
  return INTENT_COMMANDS.has(command)
}

export function parseIntentCommand(args: string[]): ParsedIntentCommand {
  const [command, ...rest] = args

  if (!command) {
    throw new Error('Intent command is required')
  }

  assertConsumerSafeCommand(command)

  const output = parseOutput(rest)

  switch (command) {
    case 'submit':
      return {
        envelope: {
          intent: 'submit_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'submit requires a fact string'),
            domain: readOption(rest, '--domain'),
            source: readOption(rest, '--source'),
            targetDocumentId: readOption(rest, '--target'),
          },
        },
        output,
      }

    case 'validate':
      return {
        envelope: {
          intent: 'validate_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'validate requires a fact string'),
            domain: readOption(rest, '--domain'),
          },
        },
        output,
      }

    case 'dispute': {
      const because = readOption(rest, '--because')
      if (!because) {
        throw new Error('dispute requires --because "<counter evidence>"')
      }
      return {
        envelope: {
          intent: 'dispute_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'dispute requires a fact string'),
            because,
            domain: readOption(rest, '--domain'),
          },
        },
        output,
      }
    }

    case 'query':
      return {
        envelope: {
          intent: 'query_truth',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            query: readPositional(rest, 0, 'query requires a topic/query string'),
            limit: parseLimit(readOption(rest, '--limit')),
            type: readOption(rest, '--type'),
          },
        },
        output,
      }

    case 'explain':
      return {
        envelope: {
          intent: 'explain_change',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'explain requires a change id or fact'),
          },
        },
        output,
      }

    default:
      throw new Error(`Unsupported intent command: ${command}`)
  }
}

export async function executeIntentCommand(
  parsed: ParsedIntentCommand,
  toolExecutor: ToolExecutor,
): Promise<IntentResult> {
  const router = new DefaultIntentRouter(toolExecutor)
  return router.execute(parsed.envelope)
}

export function formatIntentResult(result: IntentResult, output: CliOutputMode): string {
  if (output === 'json') {
    return JSON.stringify(result, null, 2)
  }

  if (isReadDocumentsResult(result)) {
    return formatReadDocumentsHumanResult(result)
  }

  const lines: string[] = []
  lines.push(`Status: ${result.status}`)
  if (typeof result.confidence === 'number') {
    lines.push(`Confidence: ${result.confidence.toFixed(2)}`)
  }
  if (result.explanation) {
    lines.push(`Why: ${result.explanation}`)
  }
  if (result.recommendedAction) {
    lines.push(`Next: ${result.recommendedAction}`)
  }
  if (result.provenance?.length) {
    lines.push(`Provenance: ${result.provenance.join(', ')}`)
  }

  const data = result.data as { results?: Array<{ metadata?: { id?: string } }> } | undefined
  const results = data?.results
  if (Array.isArray(results)) {
    lines.push(`Matches: ${results.length}`)
    if (results.length > 0) {
      const ids = results
        .map(item => item.metadata?.id)
        .filter(Boolean)
        .slice(0, 5) as string[]
      if (ids.length > 0) {
        lines.push(`Match IDs: ${ids.join(', ')}`)
      }
    }
  }

  return lines.join('\n')
}

interface ReadDocumentsResultItem {
  metadata?: {
    id?: string
    title?: string
    filePath?: string
  }
  content?: string
}

interface ReadDocumentsResultData {
  results?: ReadDocumentsResultItem[]
  total?: number
  answer?: string
  retrieval?: {
    method?: string
    detail?: string
  }
}

export async function enrichReadDocumentsAnswerWithLLM(
  parsed: ParsedIntentCommand,
  result: IntentResult,
  llmProvider?: LLMProvider,
): Promise<IntentResult> {
  if (!llmProvider) return result
  if (!isReadDocumentsResult(result)) return result
  if (process.env.KB_INTENT_LLM_ANSWER === 'false') return result

  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return result

  const question = getIntentQuestion(parsed)
  const evidence = buildEvidence(results)
  if (!question || !evidence) return result

  try {
    const completion = await llmProvider.call({
      messages: [
        {
          role: 'user',
          content: [
            'You answer using only the provided KB evidence.',
            'Return a concise, direct answer in 1-2 sentences.',
            'If evidence is insufficient, explicitly say so.',
            '',
            `Question: ${question}`,
            '',
            `Evidence:\n${evidence}`,
          ].join('\n'),
        },
      ],
      temperature: 0.1,
      maxTokens: 180,
    })

    const answer = completion.text.trim()
    if (!answer) return result

    return {
      ...result,
      data: {
        ...data,
        answer,
      },
    }
  } catch {
    return result
  }
}

function isReadDocumentsResult(result: IntentResult): boolean {
  return result.recommendedAction === 'read_documents' && result.status === 'accepted'
}

function formatReadDocumentsHumanResult(result: IntentResult): string {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []

  const lines: string[] = []
  lines.push(`Answer: ${data.answer?.trim() || buildAnswer(results)}`)
  lines.push(`Summary: ${buildSummary(results)}`)
  lines.push(`Status: ${result.status}`)

  if (typeof result.confidence === 'number') {
    lines.push(`Confidence: ${result.confidence.toFixed(2)}`)
  }

  if (result.explanation) {
    lines.push(`Why: ${result.explanation}`)
  }

  if (result.recommendedAction) {
    lines.push(`Next: ${result.recommendedAction}`)
  }

  if (data.retrieval?.method) {
    const detail = data.retrieval.detail ? ` (${data.retrieval.detail})` : ''
    lines.push(`Retrieval: ${data.retrieval.method}${detail}`)
  }

  lines.push(`Matches: ${results.length}`)

  if (results.length === 0) {
    lines.push('Relevant Docs: none')
    lines.push('Hint: Try a broader phrase, fewer keywords, or run with --output json for full retrieval details.')
    return lines.join('\n')
  }

  lines.push('Relevant Docs:')

  for (const item of results.slice(0, 5)) {
    const id = item.metadata?.id ?? 'unknown-id'
    const title = item.metadata?.title?.trim() || id
    const filePath = item.metadata?.filePath ?? 'unknown-path'
    const uri = filePath.startsWith('/') ? `file://${filePath}` : filePath
    const snippet = extractSnippet(item.content)
    const highlights = extractHighlights(item.content)
    const highlightText = highlights.length > 0
      ? highlights.map(h => `[${h.section}] ${h.excerpt}`).join(' | ')
      : 'none'
    lines.push(`- id=${id}; title=${title}; location=${filePath}; uri=${uri}; snippet=${snippet}; highlights=${highlightText}`)
  }

  if (results.length > 5) {
    lines.push(`Showing 5 of ${results.length} matches. Use --limit to adjust.`)
  }

  const ids = results
    .map(item => item.metadata?.id)
    .filter(Boolean)
    .slice(0, 10) as string[]

  if (ids.length > 0) {
    lines.push(`Provenance: ${ids.join(', ')}`)
  }

  return lines.join('\n')
}

function buildAnswer(results: ReadDocumentsResultItem[]): string {
  if (results.length === 0) {
    return 'I could not find enough evidence to answer directly from KB documents.'
  }

  const candidateLines = collectCandidateLines(results.slice(0, 3))
  if (candidateLines.length === 0) {
    return 'I found matching documents, but they do not contain a clear extractable answer line.'
  }

  const precedenceLine = candidateLines.find(line =>
    /(precedence|order|fallback|1\)|2\)|3\)|->)/i.test(line),
  )

  if (precedenceLine) {
    return precedenceLine
  }

  return candidateLines[0]
}

function getIntentQuestion(parsed: ParsedIntentCommand): string {
  const payload = parsed.envelope.payload
  const fromQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
  const fromFact = typeof payload.fact === 'string' ? payload.fact.trim() : ''
  const fromChange = typeof payload.changeId === 'string' ? payload.changeId.trim() : ''
  return fromQuery || fromFact || fromChange
}

function buildEvidence(results: ReadDocumentsResultItem[]): string {
  const sections = results.slice(0, 3).map((item, index) => {
    const id = item.metadata?.id ?? `doc-${index + 1}`
    const title = item.metadata?.title ?? id
    const content = (item.content ?? '').trim()
    if (!content) return ''

    const clipped = content.length > 1200 ? `${content.slice(0, 1200)}...` : content
    return `Document ${index + 1}: ${title} (id=${id})\n${clipped}`
  })

  return sections.filter(Boolean).join('\n\n')
}

function collectCandidateLines(items: ReadDocumentsResultItem[]): string[] {
  const candidates: string[] = []

  for (const item of items) {
    const content = item.content ?? ''
    if (!content) continue

    const lines = content
      .split('\n')
      .map(line => line.trim())
      .filter(line =>
        line.length > 0
        && !line.startsWith('#')
        && !line.startsWith('Created:')
        && !line.startsWith('Tags:')
        && !line.startsWith('Type:'),
      )

    for (const line of lines) {
      const normalized = line.replace(/^[-*]\s+/, '').trim()
      if (normalized.length < 20) continue
      candidates.push(normalized)
      if (candidates.length >= 80) return prioritizeCandidates(candidates)
    }
  }

  return prioritizeCandidates(candidates)
}

function prioritizeCandidates(candidates: string[]): string[] {
  return [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
}

function scoreCandidate(line: string): number {
  let score = 0
  if (/(precedence|order|fallback)/i.test(line)) score += 6
  if (/(1\)|2\)|3\)|->)/i.test(line)) score += 5
  if (/^(kb|cli|query|hybrid|sqlite)/i.test(line)) score += 2
  if (line.length > 40 && line.length < 220) score += 1
  return score
}

function buildSummary(results: ReadDocumentsResultItem[]): string {
  if (results.length === 0) {
    return 'No matching KB documents were found for this query.'
  }

  const lead = results[0]
  const leadTitle = lead.metadata?.title?.trim() || lead.metadata?.id || 'the top matching document'
  const leadSnippet = extractSnippet(lead.content)

  return `Found ${results.length} matching KB document${results.length === 1 ? '' : 's'}; strongest signal comes from ${leadTitle}: ${leadSnippet}`
}

function extractSnippet(content: string | undefined): string {
  if (!content) return 'No content preview available.'

  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line.length > 0
      && !line.startsWith('#')
      && !line.startsWith('Created:')
      && !line.startsWith('Tags:')
      && !line.startsWith('Type:'),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return 'No content preview available.'
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 177)}...`
}

interface HighlightRef {
  section: string
  excerpt: string
}

function extractHighlights(content: string | undefined): HighlightRef[] {
  if (!content) return []

  const lines = content.split('\n')
  const highlights: HighlightRef[] = []
  let activeSection = 'document'

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const headingMatch = line.match(/^#{2,6}\s+(.+)$/)
    if (headingMatch) {
      activeSection = headingMatch[1].trim().toLowerCase().replace(/\s+/g, '-')
      continue
    }

    if (
      line.startsWith('#')
      || line.startsWith('Created:')
      || line.startsWith('Tags:')
      || line.startsWith('Type:')
    ) {
      continue
    }

    const excerpt = line.length <= 110 ? line : `${line.slice(0, 107)}...`
    highlights.push({ section: activeSection, excerpt })
    if (highlights.length >= 2) break
  }

  return highlights
}

export function printIntentHelp(): string {
  return [
    'Intent commands:',
    '  kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]',
    '  kb validate "<fact>" [--domain ops] [--output human|json]',
    '  kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]',
    '  kb query "<topic>" [--limit 5] [--type decision] [--output human|json]',
    '  kb explain "<change id|fact>" [--output human|json]',
  ].join('\n')
}

function parseOutput(args: string[]): CliOutputMode {
  const value = readOption(args, '--output')
  if (!value) return 'human'
  if (value === 'human' || value === 'json') return value
  throw new Error('--output must be one of: human, json')
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error('--limit must be a positive integer')
  }
  return parsed
}

function readPositional(args: string[], index: number, errorMessage: string): string {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const value = positional[index]
  if (!value) {
    throw new Error(errorMessage)
  }
  return value
}

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

export function toIntentName(command: string): ConsumerIntent {
  switch (command) {
    case 'submit':
      return 'submit_fact'
    case 'validate':
      return 'validate_fact'
    case 'dispute':
      return 'dispute_fact'
    case 'query':
      return 'query_truth'
    case 'explain':
      return 'explain_change'
    default:
      throw new Error(`Unsupported command: ${command}`)
  }
}
