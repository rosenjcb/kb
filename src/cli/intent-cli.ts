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
  base?: string
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
  const base = readOption(rest, '--base')

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
            includeSessionLogs: readFlag(rest, '--include-session-logs'),
          },
        },
        output,
        base,
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
        base,
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
        base,
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
            discoveryDepth: parseDiscoveryDepth(readOption(rest, '--discovery')),
          },
        },
        output,
        base,
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
        base,
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

  if (isReconciliationReviewResult(result)) {
    return formatReconciliationReviewHumanResult(result)
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

interface ReconciliationDiffPreview {
  documentId?: string
  filePath?: string
  replacements?: number
  diff?: string
}

interface ReconciliationPreviewData {
  changedDocs?: number
  totalReplacements?: number
  proposedDiffs?: ReconciliationDiffPreview[]
}

interface ReconciliationReviewResultData {
  reconciliationPreview?: ReconciliationPreviewData
  decisionOptions?: {
    acceptFlag?: string
    passFlag?: string
  }
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
    checkpoints?: Array<{
      stage?: string
      status?: string
      nextAction?: string
      confidence?: number
    }>
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
  const evidence = buildEvidence(results, question)
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

    let answer = completion.text.trim()
    if (!answer) return result

    if (looksLikeInsufficientEvidenceAnswer(answer)) {
      const fallback = buildDeterministicIntentAnswer(question, results)
      answer = fallback
        ?? 'I do not have enough grounded evidence yet. Next step: run kb query "<your fact>" --discovery deep --output json, then kb submit "<fact>" if evidence is missing.'
    }

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

function looksLikeInsufficientEvidenceAnswer(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('evidence provided does not contain')
    || normalized.includes('retrieved documents do not provide specific information')
    || normalized.includes('does not provide specific information')
    || normalized.includes('do not provide specific information')
    || normalized.includes('does not contain specific information')
    || normalized.includes('do not contain specific information')
    || normalized.includes('do not contain specific details')
    || normalized.includes('does not provide specific details')
    || normalized.includes('do not provide specific details')
    || normalized.includes('do not contain any information about')
    || normalized.includes('does not contain any information about')
    || normalized.includes('cannot provide an answer based on the available evidence')
    || normalized.includes('evidence is insufficient')
    || normalized.includes('do not have enough evidence')
    || normalized.includes('need additional information')
  )
}

function buildDeterministicIntentAnswer(
  question: string,
  results: ReadDocumentsResultItem[],
): string | undefined {
  const normalizedQuestion = question.toLowerCase().trim()
  const highRecall = requiresHighRecallQuery(normalizedQuestion)

  for (const item of results.slice(0, 10)) {
    const docId = item.metadata?.id ?? 'unknown-doc'
    const lines = (item.content ?? '')
      .split('\n')
      .map(line => line.trim().replace(/^[-*]\s+/, ''))
      .filter(line =>
        line.length > 0
        && !line.startsWith('#')
        && !line.startsWith('Created:')
        && !line.startsWith('Tags:')
        && !line.startsWith('Type:'),
      )

    const exact = lines.find(line => line.toLowerCase().includes(normalizedQuestion))
    if (exact) {
      return `${exact} (source: ${docId})`
    }

    if (!highRecall) {
      const fallback = lines.find(line => line.length >= 25)
      if (fallback) {
        return `${fallback} (source: ${docId})`
      }
    }
  }

  return undefined
}

function requiresHighRecallQuery(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false

  const tokenLike = /^[a-z0-9._-]{16,}$/.test(trimmed)
  if (tokenLike) return true

  if (trimmed.length >= 20 && (trimmed.includes('_') || trimmed.includes('-'))) {
    return true
  }

  return false
}

function isReadDocumentsResult(result: IntentResult): boolean {
  return result.recommendedAction === 'read_documents' && result.status === 'accepted'
}

function isReconciliationReviewResult(result: IntentResult): boolean {
  return result.status === 'pending_review' && result.recommendedAction === 'review_reconciliation_diff'
}

function formatReconciliationReviewHumanResult(result: IntentResult): string {
  const data = (result.data ?? {}) as ReconciliationReviewResultData
  const preview = data.reconciliationPreview
  const diffs = Array.isArray(preview?.proposedDiffs) ? preview?.proposedDiffs : []
  const acceptFlag = data.decisionOptions?.acceptFlag ?? '--accept-reconcile'
  const passFlag = data.decisionOptions?.passFlag ?? '--pass-reconcile'

  const lines: string[] = []
  lines.push('Status: pending_review')
  if (result.explanation) {
    lines.push(`Why: ${result.explanation}`)
  }
  lines.push(`Reconciliation Preview: ${preview?.changedDocs ?? 0} docs, ${preview?.totalReplacements ?? 0} replacements`)
  lines.push(`Decision: re-run submit with ${acceptFlag} to apply changes, or ${passFlag} to skip propagation.`)

  if (diffs.length === 0) {
    lines.push('Diffs: none')
    return lines.join('\n')
  }

  lines.push('Proposed Diffs:')
  for (const entry of diffs.slice(0, 5)) {
    const label = entry.documentId ?? 'unknown-doc'
    const replacementCount = typeof entry.replacements === 'number' ? entry.replacements : 0
    const diffText = typeof entry.diff === 'string' ? entry.diff : ''
    const trimmedDiff = diffText
      .split('\n')
      .slice(0, 40)
      .join('\n')
    lines.push(`--- ${label} (${replacementCount} replacements) ---`)
    lines.push(trimmedDiff || '(no diff preview available)')
  }

  if (diffs.length > 5) {
    lines.push(`Showing 5 of ${diffs.length} diff previews.`)
  }

  return lines.join('\n')
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

  if (Array.isArray(data.retrieval?.checkpoints) && data.retrieval.checkpoints.length > 0) {
    const trace = data.retrieval.checkpoints
      .map(checkpoint => {
        const stage = checkpoint.stage ?? 'unknown-stage'
        const status = checkpoint.status ?? 'unknown-status'
        const next = checkpoint.nextAction ?? 'unknown-action'
        return `${stage}:${status}->${next}`
      })
      .join(' | ')
    lines.push(`Checkpoints: ${trace}`)
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

function buildEvidence(results: ReadDocumentsResultItem[], query: string): string {
  const sections = results.slice(0, 5).map((item, index) => {
    const id = item.metadata?.id ?? `doc-${index + 1}`
    const title = item.metadata?.title ?? id
    const snippets = extractRelevantEvidenceSnippets(item.content, query)
    if (snippets.length === 0) return ''
    return `Document ${index + 1}: ${title} (id=${id})\n${snippets.join('\n')}`
  })

  return sections.filter(Boolean).join('\n\n')
}

function extractRelevantEvidenceSnippets(content: string | undefined, query: string): string[] {
  if (!content?.trim()) return []

  const queryTokens = tokenizeForEvidence(query)
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

  if (lines.length === 0) return []

  const scored = lines
    .map((line, index) => ({
      line,
      index,
      score: scoreEvidenceLine(line, queryTokens),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  const exploredWindows: string[] = []
  const usedLineIndexes = new Set<number>()

  for (const hit of scored) {
    const windowStart = Math.max(0, hit.index - 1)
    const windowEnd = Math.min(lines.length - 1, hit.index + 1)
    const windowLines: string[] = []

    for (let i = windowStart; i <= windowEnd; i += 1) {
      const candidate = lines[i]
      if (candidate.length < 20) continue
      if (usedLineIndexes.has(i)) continue
      usedLineIndexes.add(i)
      windowLines.push(candidate)
    }

    if (windowLines.length > 0) {
      exploredWindows.push(`- ${windowLines.join(' | ')}`)
    }
  }

  if (exploredWindows.length > 0) {
    return exploredWindows
  }

  return lines
    .filter(line => line.length >= 30)
    .slice(0, 2)
    .map(line => `- ${line}`)
}

function tokenizeForEvidence(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
}

function scoreEvidenceLine(line: string, queryTokens: string[]): number {
  const normalized = line.toLowerCase()
  let score = 0

  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      score += 2
    }
  }

  if (/(kb|cli|command|query|submit|validate|dispute|explain|chat|help)/i.test(line)) {
    score += 3
  }

  if (line.length > 35 && line.length < 260) {
    score += 1
  }

  return score
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
    '  kb submit "<fact>" [--base <name>] [--domain ops] [--source runbook] [--target doc-id] [--include-session-logs] [--output human|json]',
    '  kb validate "<fact>" [--base <name>] [--domain ops] [--output human|json]',
    '  kb dispute "<fact>" --because "<counter evidence>" [--base <name>] [--domain ops] [--output human|json]',
    '  kb query "<topic>" [--base <name>] [--limit 5] [--type decision] [--discovery shallow|deep] [--output human|json]',
    '  kb explain "<change id|fact>" [--base <name>] [--output human|json]',
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

function parseDiscoveryDepth(value: string | undefined): 'shallow' | 'deep' | undefined {
  if (!value) return undefined
  if (value === 'shallow' || value === 'deep') return value
  throw new Error('--discovery must be one of: shallow, deep')
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

function readFlag(args: string[], option: string): boolean {
  return args.includes(option)
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
