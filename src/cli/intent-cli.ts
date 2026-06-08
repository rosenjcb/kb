import dayjs from 'dayjs'
import { formatEvidenceSummaryHeader } from '../core/evidence-summary'
import { formatRetrievedFactsForLLM } from '../core/retrieval-context'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message } from '../core/types'
import { assertConsumerSafeCommand } from '../intents/policy'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntent, ConsumerIntentEnvelope, IntentResult } from '../intents/types'
import { formatOrchestrationMetaLine } from '../ui/orchestration-meta.js'
import type { Printer } from '../ui/printer'
import { type CmdMode, cmd } from './cmd-ref'
import { appendQuerySession, loadQuerySessionMessages } from './query-session'
import { formatReadDocumentSourcesPreview } from './retrieval-fallback'


export function formatRetrievalMatchesMeta(retrievedCount: number): string {
  if (retrievedCount === 0) return '0'
  return `${retrievedCount} ranked facts`
}

export interface ParsedIntentCommand {
  envelope: ConsumerIntentEnvelope
  base?: string
  /** Extra human orchestration rows (summary, status, confidence) for query/chat. */
  verbose?: boolean
  /**
   * When true (`kb query --session`), use `query-session.json` under the
   * active base for follow-up rewrite + enrichment context + append. Default false matches chat
   * (no silent session mutation of the retrieval query).
   */
  useQuerySession?: boolean
  /** When true (`kb query --all-facts`), bypass query expansion and load all KB facts. */
  allFacts?: boolean
}

/** Human read_facts footer: default minimal; verbose adds summary/status/confidence. */
export interface ReadDocumentsHumanOutputOptions {
  verbose?: boolean
}

const INTENT_COMMANDS = new Set(['query'])
const INTENT_LLM_MAX_OUTPUT_TOKENS = 4096

export function isIntentCommand(command: string): boolean {
  return INTENT_COMMANDS.has(command)
}

export function parseIntentCommand(args: string[]): ParsedIntentCommand {
  const [command, ...rest] = args

  if (!command) {
    throw new Error('Intent command is required')
  }

  if (rest.includes('--help') || rest.includes('-h') || rest[0] === 'help') {
    throw new Error(printIntentHelp())
  }

  assertConsumerSafeCommand(command)

  const base = readOption(rest, '--base')
  const verbose = readFlag(rest, '--verbose')

  let envelope: ConsumerIntentEnvelope

  switch (command) {
    case 'query':
      envelope = {
        intent: 'query_truth',
        requestId: `req-${dayjs().valueOf()}`,
        payload: {
          query: readPositional(rest, 0, 'query requires a topic/query string'),
          limit: parseLimit(readOption(rest, '--limit')),
          type: readOption(rest, '--type'),
          discoveryDepth: parseDiscoveryDepth(readOption(rest, '--discovery')),
        },
      }
      break

    default:
      throw new Error(`Unsupported intent command: ${command}`)
  }

  const useQuerySession = command === 'query' && readFlag(rest, '--session')

  return { envelope, base, verbose, useQuerySession }
}

export interface ExecuteIntentCommandOptions {
  intentLlm?: LLMProvider
  kbStorageDir?: string
}

export async function executeIntentCommand(
  parsed: ParsedIntentCommand,
  toolExecutor: ToolExecutor,
  options?: ExecuteIntentCommandOptions
): Promise<IntentResult> {
  const router = new DefaultIntentRouter(toolExecutor, options?.intentLlm, options?.kbStorageDir)
  return router.execute(parsed.envelope)
}

function normalizeReadDocumentsHumanOptions(
  options?: ReadDocumentsHumanOutputOptions | boolean
): ReadDocumentsHumanOutputOptions {
  if (typeof options === 'boolean') {
    return { verbose: options }
  }
  return options ?? {}
}

export function formatIntentResult(
  result: IntentResult,
  options?: ReadDocumentsHumanOutputOptions | boolean
): string {
  const readDocsOpts = normalizeReadDocumentsHumanOptions(options)

  if (isReadFactsResult(result)) {
    return formatReadDocumentsHumanResult(result, readDocsOpts)
  }

  if (isReconciliationReviewResult(result)) {
    return formatReconciliationReviewHumanResult(result)
  }

  const lines: string[] = []
  lines.push(formatOrchestrationMetaLine('status', result.status))
  if (typeof result.confidence === 'number') {
    lines.push(formatOrchestrationMetaLine('confidence', result.confidence.toFixed(2)))
  }
  if (result.recommendedAction) {
    lines.push(formatOrchestrationMetaLine('next', result.recommendedAction))
  }

  const data = result.data as { results?: Array<{ metadata?: { id?: string } }> } | undefined
  const results = data?.results
  if (Array.isArray(results)) {
    lines.push(formatOrchestrationMetaLine('matches', formatRetrievalMatchesMeta(results.length)))
  }

  return lines.join('\n')
}

export function printIntentResult(
  result: IntentResult,
  printer: Printer,
  options?: ReadDocumentsHumanOutputOptions
): void {
  if (isReadFactsResult(result)) {
    printReadDocumentsHumanResult(result, printer, options)
    return
  }

  if (isReconciliationReviewResult(result)) {
    printer.content(formatReconciliationReviewHumanResult(result))
    return
  }

  printer.metadata('Status', result.status)
  if (typeof result.confidence === 'number') {
    printer.metadata('Confidence', result.confidence.toFixed(2))
  }
  if (result.recommendedAction) {
    printer.metadata('Next', result.recommendedAction)
  }

  const data = result.data as { results?: Array<{ metadata?: { id?: string } }> } | undefined
  const results = data?.results
  if (Array.isArray(results)) {
    printer.metadata('Matches', formatRetrievalMatchesMeta(results.length))
  }
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

export interface ReadDocumentsResultItem {
  metadata?: {
    id?: string
    title?: string
    filePath?: string
    tags?: string[]
  }
  content?: string
  /** Graph rerank hints from the KB graph store (includes relationship type labels). */
  graphEvidence?: string[]
}

export interface ReadDocumentsResultData {
  results?: ReadDocumentsResultItem[]
  total?: number
  answer?: string
  retrieval?: {
    method?: string
    detail?: string
    traceDetail?: string
    checkpoints?: Array<{
      stage?: string
      status?: string
      nextAction?: string
      confidence?: number
    }>
  }
}

function appendReadDocumentsSourcesToLines(
  lines: string[],
  results: ReadDocumentsResultItem[]
): void {
  if (results.length === 0) {
    lines.push(formatOrchestrationMetaLine('sources', '(none)'))
    return
  }
  lines.push(formatOrchestrationMetaLine('sources', formatReadDocumentSourcesPreview(results)))
}

function printReadDocumentsSourcesBlock(
  printer: Printer,
  results: ReadDocumentsResultItem[]
): void {
  if (results.length === 0) {
    printer.metadata('Sources', '(none)')
    return
  }
  printer.metadata('Sources', formatReadDocumentSourcesPreview(results))
}

/** Same orchestration block as `kb query` human output (after the answer + ---). */
export function printReadDocumentsOrchestrationFooter(
  printer: Printer,
  result: IntentResult,
  options?: ReadDocumentsHumanOutputOptions
): void {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  const verbose = options?.verbose === true

  if (verbose) {
    printer.metadata('Summary', buildSummary(results))
    printer.metadata('Status', result.status)
    if (typeof result.confidence === 'number') {
      printer.metadata('Confidence', result.confidence.toFixed(2))
    }
  }

  if (data.retrieval?.method) {
    const base = data.retrieval.detail ?? ''
    const detail = base ? ` (${base})` : ''
    printer.metadata('Retrieval', `${data.retrieval.method}${detail}`)
  }

  printer.metadata('Matches', formatRetrievalMatchesMeta(results.length))
  printReadDocumentsSourcesBlock(printer, results)
}

export async function enrichReadDocumentsAnswerWithLLM(
  parsed: ParsedIntentCommand,
  result: IntentResult,
  llmProvider?: LLMProvider,
  sessionDir?: string,
  priorMessages?: Message[],
  options?: { graphRelationContext?: string }
): Promise<IntentResult> {
  if (!llmProvider) return result
  if (!isReadFactsResult(result)) return result
  if (process.env.KB_INTENT_LLM_ANSWER === 'false') return result

  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return result

  const question = getIntentQuestion(parsed)
  const evidence = buildEvidence(results, parsed.allFacts)
  if (!question || !evidence) return result

  try {
    const sessionTurns: Message[] = sessionDir ? await loadQuerySessionMessages(sessionDir) : []

    const contextMessages: Message[] = priorMessages ?? sessionTurns

    const graphSection = options?.graphRelationContext?.trim()
      ? [
          '',
          'Structured graph path (shortest directed path in the KB graph when the question is relational; must agree with document evidence, not override it):',
          options.graphRelationContext.trim(),
        ].join('\n')
      : ''

    const userContent = [
      'Answer from the evidence below. Always give a useful response — for broad questions a high-level summary is fine; for specific questions be precise. Only say evidence is insufficient if the question is completely unrelated to anything retrieved.',
      '',
      `Question: ${question}`,
      graphSection,
      '',
      `Evidence:\n${evidence}`,
    ].join('\n')

    const completion = await llmProvider.call({
      messages: [...contextMessages, { role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: INTENT_LLM_MAX_OUTPUT_TOKENS,
    })

    let answer = completion.text.trim()
    if (!answer) return result

    if (looksLikeInsufficientEvidenceAnswer(answer)) {
      answer = buildDeterministicIntentAnswer(question, results) ?? ''
      if (!answer) return result
    }
    const scaffolded = buildBuildConfigScaffoldAnswer(question, results)
    if (scaffolded && answerNeedsScaffoldRecovery(question, answer)) {
      answer = scaffolded
    }

    if (sessionDir) {
      void appendQuerySession(sessionDir, question, answer)
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

export async function rewriteIntentInputWithSessionContext(
  parsed: ParsedIntentCommand,
  llmProvider?: LLMProvider,
  sessionDir?: string
): Promise<ParsedIntentCommand> {
  if (!llmProvider || !sessionDir) return parsed
  if (parsed.envelope.intent !== 'query_truth') {
    return parsed
  }

  const latestInput = getIntentQuestion(parsed)
  if (!latestInput) return parsed

  const sessionTurns = await loadQuerySessionMessages(sessionDir)
  if (sessionTurns.length === 0) return parsed

  try {
    const completion = await llmProvider.call({
      messages: [
        ...sessionTurns,
        {
          role: 'user',
          content: [
            'Rewrite the latest KB CLI request as a standalone retrieval query using the prior conversation only when needed.',
            'If the latest request is already standalone, return it unchanged.',
            'Return only the rewritten standalone query text. No quotes, no explanation.',
            '',
            `Latest request: ${latestInput}`,
          ].join('\n'),
        },
      ],
      temperature: 0.0,
      maxTokens: 128,
    })

    const rewritten = completion.text.trim().replace(/^["']|["']$/g, '')
    if (!rewritten || rewritten.toLowerCase() === latestInput.toLowerCase()) {
      return parsed
    }

    const payload = { ...parsed.envelope.payload }
    if (typeof payload.query === 'string') {
      payload.originalQuery = payload.query
      payload.query = rewritten
    } else if (typeof payload.fact === 'string') {
      payload.originalFact = payload.fact
      payload.fact = rewritten
    } else {
      return parsed
    }

    return {
      ...parsed,
      envelope: {
        ...parsed.envelope,
        payload,
      },
    }
  } catch {
    return parsed
  }
}

function looksLikeInsufficientEvidenceAnswer(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('evidence provided does not contain') ||
    normalized.includes('retrieved documents do not provide specific information') ||
    normalized.includes('does not provide specific information') ||
    normalized.includes('do not provide specific information') ||
    normalized.includes('does not contain specific information') ||
    normalized.includes('do not contain specific information') ||
    normalized.includes('do not contain specific details') ||
    normalized.includes('does not provide specific details') ||
    normalized.includes('do not provide specific details') ||
    normalized.includes('do not contain any information about') ||
    normalized.includes('does not contain any information about') ||
    normalized.includes('cannot provide an answer based on the available evidence') ||
    normalized.includes('evidence is insufficient') ||
    normalized.includes('do not have enough evidence') ||
    normalized.includes('need additional information')
  )
}

function buildDeterministicIntentAnswer(
  question: string,
  results: ReadDocumentsResultItem[]
): string | undefined {
  const normalizedQuestion = question.toLowerCase().trim()
  const highRecall = requiresHighRecallQuery(normalizedQuestion)

  for (const item of results.slice(0, 10)) {
    const docId = item.metadata?.id ?? 'unknown-doc'
    const lines = (item.content ?? '')
      .split('\n')
      .map(line => line.trim().replace(/^[-*]\s+/, ''))
      .filter(
        line =>
          line.length > 0 &&
          !line.startsWith('#') &&
          !line.startsWith('Created:') &&
          !line.startsWith('Tags:') &&
          !line.startsWith('Type:')
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


function findEvidenceLine(
  results: ReadDocumentsResultItem[],
  keywords: string[]
): { line: string; docId: string } | undefined {
  for (const item of results.slice(0, 10)) {
    const docId = item.metadata?.id ?? 'unknown-doc'
    const lines = (item.content ?? '')
      .split('\n')
      .map(line => line.trim().replace(/^[-*]\s+/, ''))
      .filter(
        line =>
          line.length >= 24 &&
          !line.startsWith('#') &&
          !line.startsWith('Created:') &&
          !line.startsWith('Tags:') &&
          !line.startsWith('Type:')
      )
    for (const line of lines) {
      const normalized = line.toLowerCase()
      if (keywords.some(keyword => normalized.includes(keyword))) {
        return { line, docId }
      }
    }
  }
  return undefined
}

function answerNeedsScaffoldRecovery(question: string, answer: string): boolean {
  if (!isBuildOrConfigQuestion(question)) return false
  const normalized = answer.toLowerCase()
  const requiredSections = [
    'prerequisites',
    'commands',
    'flags/options',
    'platform notes',
    'known gotchas',
  ]
  const present = requiredSections.filter(section => normalized.includes(section)).length
  return present < 3
}

function buildBuildConfigScaffoldAnswer(
  question: string,
  results: ReadDocumentsResultItem[]
): string | undefined {
  if (!isBuildOrConfigQuestion(question)) return undefined

  const sectionSpecs: Array<{ title: string; keywords: string[] }> = [
    {
      title: 'Prerequisites',
      keywords: ['prereq', 'require', 'dependency', 'install', 'toolchain'],
    },
    { title: 'Commands', keywords: ['cmake', 'make', 'build', 'compile', 'run', 'command'] },
    { title: 'Flags/Options', keywords: ['flag', 'option', 'define', 'switch', '--', '-d'] },
    {
      title: 'Platform Notes',
      keywords: ['linux', 'windows', 'macos', 'android', 'web', 'platform'],
    },
    { title: 'Known Gotchas', keywords: ['gotcha', 'caveat', 'warning', 'limitation', 'note'] },
  ]

  const lines = ['Build/config evidence scaffold:']
  let found = 0
  for (const spec of sectionSpecs) {
    const evidence = findEvidenceLine(results, spec.keywords)
    if (evidence) {
      lines.push(`- ${spec.title}: ${evidence.line} (source: ${evidence.docId})`)
      found += 1
    } else {
      lines.push(`- ${spec.title}: no direct evidence found in current retrieval set.`)
    }
  }
  return found > 0 ? lines.join('\n') : undefined
}

function isBuildOrConfigQuestion(question: string): boolean {
  const normalized = question.toLowerCase()
  return /(build|config|configure|flag|option|install|setup|cmake|compile|dependency)/.test(
    normalized
  )
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

export function isReadFactsResult(result: IntentResult): boolean {
  return result.recommendedAction === 'read_facts' && result.status === 'accepted'
}

function isReconciliationReviewResult(result: IntentResult): boolean {
  return (
    result.status === 'pending_review' && result.recommendedAction === 'review_reconciliation_diff'
  )
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
  lines.push(
    `Reconciliation Preview: ${preview?.changedDocs ?? 0} docs, ${preview?.totalReplacements ?? 0} replacements`
  )
  lines.push(
    `Decision: re-run with ${acceptFlag} to apply changes, or ${passFlag} to skip propagation.`
  )

  if (diffs.length === 0) {
    lines.push('Diffs: none')
    return lines.join('\n')
  }

  lines.push('Proposed Diffs:')
  for (const entry of diffs.slice(0, 5)) {
    const label = entry.documentId ?? 'unknown-doc'
    const replacementCount = typeof entry.replacements === 'number' ? entry.replacements : 0
    const diffText = typeof entry.diff === 'string' ? entry.diff : ''
    const trimmedDiff = diffText.split('\n').slice(0, 40).join('\n')
    lines.push(`--- ${label} (${replacementCount} replacements) ---`)
    lines.push(trimmedDiff || '(no diff preview available)')
  }

  if (diffs.length > 5) {
    lines.push(`Showing 5 of ${diffs.length} diff previews.`)
  }

  return lines.join('\n')
}

function formatReadDocumentsHumanResult(
  result: IntentResult,
  options?: ReadDocumentsHumanOutputOptions
): string {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  const verbose = options?.verbose === true

  const lines: string[] = []
  lines.push(data.answer?.trim() || buildAnswer(results))
  lines.push('---')

  const evidenceSummary = formatEvidenceSummaryHeader({ results, retrieval: data.retrieval })
  if (evidenceSummary) {
    lines.push(formatOrchestrationMetaLine('evidence', evidenceSummary))
  }

  if (verbose) {
    lines.push(formatOrchestrationMetaLine('summary', buildSummary(results)))
    lines.push(formatOrchestrationMetaLine('status', result.status))
    if (typeof result.confidence === 'number') {
      lines.push(formatOrchestrationMetaLine('confidence', result.confidence.toFixed(2)))
    }
  }

  if (data.retrieval?.method) {
    const base = data.retrieval.detail ?? ''
    const detail = base ? ` (${base})` : ''
    lines.push(formatOrchestrationMetaLine('retrieval', `${data.retrieval.method}${detail}`))
  }

  lines.push(formatOrchestrationMetaLine('matches', formatRetrievalMatchesMeta(results.length)))
  appendReadDocumentsSourcesToLines(lines, results)

  return lines.join('\n')
}

function printReadDocumentsHumanResult(
  result: IntentResult,
  printer: Printer,
  options?: ReadDocumentsHumanOutputOptions
): void {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []

  printer.content(data.answer?.trim() || buildAnswer(results))
  printer.separator()
  printEvidenceSummaryBlock(printer, results, data.retrieval)
  printReadDocumentsOrchestrationFooter(printer, result, options)
}

function printEvidenceSummaryBlock(
  printer: Printer,
  results: ReadDocumentsResultItem[],
  retrieval?: ReadDocumentsResultData['retrieval']
): void {
  const summary = formatEvidenceSummaryHeader({ results, retrieval })
  if (!summary) return
  printer.orchestrationMeta('evidence', summary)
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

function buildAnswer(results: ReadDocumentsResultItem[]): string {
  if (results.length === 0) {
    return 'I could not find enough evidence to answer directly from KB documents.'
  }

  const candidateLines = collectCandidateLines(results.slice(0, 3))
  if (candidateLines.length === 0) {
    return 'I found matching documents, but they do not contain a clear extractable answer line.'
  }

  const precedenceLine = candidateLines.find(line =>
    /(precedence|order|fallback|1\)|2\)|3\)|->)/i.test(line)
  )

  if (precedenceLine) {
    return precedenceLine
  }

  return candidateLines[0]
}

function getIntentQuestion(parsed: ParsedIntentCommand): string {
  const payload = parsed.envelope.payload
  const fromOriginalQuery =
    typeof payload.originalQuery === 'string' ? payload.originalQuery.trim() : ''
  const fromOriginalFact =
    typeof payload.originalFact === 'string' ? payload.originalFact.trim() : ''
  const fromQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
  const fromFact = typeof payload.fact === 'string' ? payload.fact.trim() : ''
  const fromChange = typeof payload.changeId === 'string' ? payload.changeId.trim() : ''
  return fromOriginalQuery || fromOriginalFact || fromQuery || fromFact || fromChange
}

function buildEvidence(results: ReadDocumentsResultItem[], _allFacts?: boolean): string {
  return formatRetrievedFactsForLLM(results, {
    heading: (item, index) => {
      const id = item.metadata?.id ?? `doc-${index + 1}`
      const title = item.metadata?.title ?? id
      return `Document ${index + 1}: ${title} (id=${id})`
    },
  })
}

function collectCandidateLines(items: ReadDocumentsResultItem[]): string[] {
  const candidates: string[] = []

  for (const item of items) {
    const content = item.content ?? ''
    if (!content) continue

    const lines = content
      .split('\n')
      .map(line => line.trim())
      .filter(
        line =>
          line.length > 0 &&
          !line.startsWith('#') &&
          !line.startsWith('Created:') &&
          !line.startsWith('Tags:') &&
          !line.startsWith('Type:')
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

function extractSnippet(content: string | undefined): string {
  if (!content) return 'No content preview available.'

  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith('Created:') &&
        !line.startsWith('Tags:') &&
        !line.startsWith('Type:')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return 'No content preview available.'
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 177)}...`
}


export function printIntentHelp(mode: CmdMode = 'cli'): string {
  return [
    'Intent commands:',
    `  ${cmd('query "<topic>" [--base <name>] [--limit <n>] [--type decision] [--discovery shallow|deep] [--session] [--verbose]', mode)}`,
  ].join('\n')
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
    case 'query':
      return 'query_truth'
    default:
      throw new Error(`Unsupported command: ${command}`)
  }
}
