import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message } from '../core/types'
import { assertConsumerSafeCommand } from '../intents/policy'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntent, ConsumerIntentEnvelope, IntentResult } from '../intents/types'
import { formatOrchestrationMetaLine } from '../ui/orchestration-meta.js'
import type { Printer } from '../ui/printer'
import { type CmdMode, cmd } from './cmd-ref'
import { appendQuerySession, loadQuerySessionMessages } from './query-session'
import {
  augmentReadDocumentsWithWorkspaceFallback,
  formatReadDocumentSourceIds,
} from './retrieval-fallback'

export type CliOutputMode = 'human' | 'json'

export interface ParsedIntentCommand {
  envelope: ConsumerIntentEnvelope
  output: CliOutputMode
  base?: string
  debug?: boolean
  /** Extra human orchestration rows (summary, status, confidence) for query/chat. */
  verbose?: boolean
  /**
   * When true (`kb query --session`), use `query-session.json` under the
   * active base for follow-up rewrite + enrichment context + append. Default false matches chat
   * (no silent session mutation of the retrieval query).
   */
  useQuerySession?: boolean
}

/** Human read_documents footer: default minimal; verbose adds summary/status/confidence; debug expands sources. */
export interface ReadDocumentsHumanOutputOptions {
  verbose?: boolean
  /** When true, emit one `source>` line per hit with id, path, uri, snippet, highlights (default is a single `sources>` titles line). */
  debug?: boolean
}

const INTENT_COMMANDS = new Set(['submit', 'query', 'invalidate'])
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

  const output = parseOutput(rest)
  const base = readOption(rest, '--base')
  const debug = readFlag(rest, '--debug')
  const verbose = readFlag(rest, '--verbose')

  let envelope: ConsumerIntentEnvelope

  switch (command) {
    case 'submit':
      envelope = {
        intent: 'submit_fact',
        requestId: `req-${dayjs().valueOf()}`,
        payload: {
          fact: readPositional(rest, 0, 'submit requires a fact string'),
          domain: readOption(rest, '--domain'),
          source: readOption(rest, '--source'),
          includeSessionLogs: readFlag(rest, '--include-session-logs'),
        },
      }
      break

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

    case 'invalidate': {
      if (readFlag(rest, '--apply')) {
        throw new Error(
          'Invalid flags: kb invalidate no longer accepts --apply; KB updates apply by default. Use --preview to plan without writes.'
        )
      }
      const invalidatePreview = readFlag(rest, '--preview')
      const invalidateDryRun = readFlag(rest, '--dry-run')
      if (invalidatePreview && invalidateDryRun) {
        throw new Error('Invalid flags: --preview cannot be combined with --dry-run')
      }
      envelope = {
        intent: 'invalidate_fact',
        requestId: `req-${dayjs().valueOf()}`,
        payload: {
          oldFact: readPositional(rest, 0, 'invalidate requires an old fact string'),
          replacementFact: readOptionalPositional(rest, 1),
          preview: invalidatePreview,
          dryRun: invalidateDryRun,
          includeSessionLogs: true,
        },
      }
      break
    }

    default:
      throw new Error(`Unsupported intent command: ${command}`)
  }

  const useQuerySession = command === 'query' && readFlag(rest, '--session')

  return { envelope, output, base, debug, verbose, useQuerySession }
}

export async function executeIntentCommand(
  parsed: ParsedIntentCommand,
  toolExecutor: ToolExecutor
): Promise<IntentResult> {
  const router = new DefaultIntentRouter(toolExecutor)
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
  output: CliOutputMode,
  options?: ReadDocumentsHumanOutputOptions | boolean
): string {
  const readDocsOpts = normalizeReadDocumentsHumanOptions(options)

  if (output === 'json') {
    return JSON.stringify(result, null, 2)
  }

  if (isReadDocumentsResult(result)) {
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
    lines.push(formatOrchestrationMetaLine('matches', String(results.length)))
  }

  return lines.join('\n')
}

export function printIntentResult(
  result: IntentResult,
  output: CliOutputMode,
  printer: Printer,
  options?: ReadDocumentsHumanOutputOptions
): void {
  if (output === 'json') {
    printer.content(JSON.stringify(result, null, 2))
    return
  }

  if (isReadDocumentsResult(result)) {
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
    printer.metadata('Matches', String(results.length))
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

interface ReadDocumentsResultItem {
  metadata?: {
    id?: string
    title?: string
    filePath?: string
  }
  content?: string
  /** Graph rerank hints from DuckDB (includes relationship type labels). */
  graphEvidence?: string[]
}

export interface ReadDocumentsResultData {
  results?: ReadDocumentsResultItem[]
  total?: number
  answer?: string
  /** Set by **`enrichReadDocumentsAnswerWithLLM`** when the model returns structured JSON. */
  answerEvidence?: 'sufficient' | 'insufficient'
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

function documentDisplayTitle(item: ReadDocumentsResultItem): string {
  const id = item.metadata?.id ?? 'unknown-id'
  return item.metadata?.title?.trim() || id
}

function formatReadDocumentsFullSourceValue(item: ReadDocumentsResultItem): string {
  const id = item.metadata?.id ?? 'unknown-id'
  const title = item.metadata?.title?.trim() || id
  const filePath = item.metadata?.filePath ?? 'unknown-path'
  const uri = filePath.startsWith('/') ? `file://${filePath}` : filePath
  const snippet = extractSnippet(item.content)
  const highlights = extractHighlights(item.content)
  const highlightText =
    highlights.length > 0 ? highlights.map(h => `[${h.section}] ${h.excerpt}`).join(' | ') : 'none'
  return `id=${id}; title=${title}; location=${filePath}; uri=${uri}; snippet=${snippet}; highlights=${highlightText}`
}

function appendReadDocumentsSourcesToLines(
  lines: string[],
  results: ReadDocumentsResultItem[],
  options?: ReadDocumentsHumanOutputOptions
): void {
  const debug = options?.debug === true
  if (results.length === 0) {
    lines.push(formatOrchestrationMetaLine('sources', '(none)'))
    return
  }
  if (debug) {
    for (const item of results) {
      lines.push(formatOrchestrationMetaLine('source', formatReadDocumentsFullSourceValue(item)))
    }
  } else {
    lines.push(formatOrchestrationMetaLine('sources', results.map(documentDisplayTitle).join('; ')))
  }
}

function printReadDocumentsSourcesBlock(
  printer: Printer,
  results: ReadDocumentsResultItem[],
  options?: ReadDocumentsHumanOutputOptions
): void {
  const debug = options?.debug === true
  if (results.length === 0) {
    printer.metadata('Sources', '(none)')
    return
  }
  if (debug) {
    for (const item of results) {
      printer.metadata('Source', formatReadDocumentsFullSourceValue(item))
    }
  } else {
    printer.metadata('Sources', results.map(documentDisplayTitle).join('; '))
  }
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
    const detail = data.retrieval.detail ? ` (${data.retrieval.detail})` : ''
    printer.metadata('Retrieval', `${data.retrieval.method}${detail}`)
  }

  printer.metadata('Matches', String(results.length))
  printReadDocumentsSourcesBlock(printer, results, options)
}

const INTENT_ENRICHMENT_JSON_INSTRUCTION = [
  'Respond with a single JSON object only (no markdown code fences, no text before or after the JSON).',
  'Schema: {"evidence":"sufficient"|"insufficient","answer":"<string>"}',
  'Use evidence "insufficient" only when the evidence block cannot support a correct, grounded answer to the question.',
  'When evidence is "sufficient", "answer" must be the full user-facing reply, using only the evidence.',
  'When evidence is "insufficient", "answer" must briefly explain the gap, then ask one or two short questions that narrow scope',
  '(e.g. whether they mean this project KB vs a general question, or which subsystem). Do not invent facts to fill the gap.',
  'If the question is clearly general philosophy or existential (meaning of life, purpose of the universe, why we exist) and the evidence is only technical project docs, evidence MUST be "insufficient".',
].join(' ')

/** Broad questions not scoped to this repo; KB hits are usually irrelevant — force clarify path. */
function queryLikelyOutsideProjectKb(question: string): boolean {
  const q = question.trim().toLowerCase()
  if (q.length < 8) return false

  const kbScoped =
    /\b(kb\s|knowledge\s+base|this\s+repo|this\s+project|the\s+cli|codebase|\.kb\b|sqlite|hybrid\s+retrieval|intent\s+command)\b/i.test(
      question
    )
  if (kbScoped) return false

  return (
    /\b(purpose|meaning)\s+of\s+(life|existence|the\s+universe|everything)\b/.test(q) ||
    /\bwhat\s+is\s+the\s+(purpose|meaning)\s+of\s+life\b/.test(q) ||
    /\bwhy\s+(are|do)\s+we\s+(exist|here)\b/.test(q)
  )
}

const PHILOSOPHY_GATE_FALLBACK_ANSWER = [
  'Those KB documents describe this project’s CLI and tooling — they do not answer broad existential questions.',
  'Do you mean something inside this repository (e.g. hybrid retrieval, `kb query`, or init)?',
  'Or were you asking a general question outside this KB?',
].join(' ')

function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/im)
  if (fence) return fence[1].trim()
  return trimmed
}

function parseIntentEnrichmentJson(
  text: string
): { evidence: 'sufficient' | 'insufficient'; answer: string } | undefined {
  const raw = stripMarkdownJsonFence(text)
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const evidence = obj.evidence
    const answer = obj.answer
    if (evidence !== 'sufficient' && evidence !== 'insufficient') return undefined
    if (typeof answer !== 'string') return undefined
    return { evidence, answer: answer.trim() }
  } catch {
    return undefined
  }
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
  if (!isReadDocumentsResult(result)) return result
  if (process.env.KB_INTENT_LLM_ANSWER === 'false') return result

  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return result

  const question = getIntentQuestion(parsed)
  const evidence = buildEvidence(results, question)
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
      'Ground yourself only in the evidence below.',
      '',
      `Question: ${question}`,
      graphSection,
      '',
      `Evidence:\n${evidence}`,
      '',
      INTENT_ENRICHMENT_JSON_INSTRUCTION,
    ].join('\n')

    const completion = await llmProvider.call({
      systemPrompt:
        'You answer KB queries strictly from supplied evidence. Follow the JSON output contract in the user message.',
      messages: [...contextMessages, { role: 'user', content: userContent }],
      temperature: 0.1,
      maxTokens: INTENT_LLM_MAX_OUTPUT_TOKENS,
    })

    const rawCompletion = completion.text.trim()
    if (!rawCompletion) return result

    const deterministicFallback =
      buildDeterministicIntentAnswer(question, results) ??
      'I do not have enough grounded evidence yet. Next step: run kb query "<your fact>" --discovery deep --output json, then kb submit "<fact>" if evidence is missing.'

    const structured = parseIntentEnrichmentJson(rawCompletion)
    const outsideKb = queryLikelyOutsideProjectKb(question)

    let answer: string
    let answerEvidence: 'sufficient' | 'insufficient' | undefined

    if (outsideKb) {
      answerEvidence = 'insufficient'
      if (
        structured?.evidence === 'insufficient' &&
        structured.answer.trim().length > 12 &&
        structured.answer.includes('?')
      ) {
        answer = structured.answer.trim()
      } else {
        answer = PHILOSOPHY_GATE_FALLBACK_ANSWER
      }
    } else {
      answerEvidence = structured?.evidence
      answer = structured ? structured.answer.trim() || deterministicFallback : rawCompletion
    }

    if (!answer.trim()) return result

    if (sessionDir) {
      void appendQuerySession(sessionDir, question, answer)
    }

    return {
      ...result,
      data: {
        ...data,
        answer,
        ...(answerEvidence ? { answerEvidence } : {}),
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

export async function augmentIntentResultWithWorkspaceFallback(
  parsed: ParsedIntentCommand,
  result: IntentResult,
  workspaceDir: string
): Promise<IntentResult> {
  if (!isReadDocumentsResult(result)) return result
  if (parsed.envelope.intent !== 'query_truth') {
    return result
  }

  const question = getIntentQuestion(parsed)
  if (!question) return result

  const data = (result.data ?? {}) as ReadDocumentsResultData
  const augmented = await augmentReadDocumentsWithWorkspaceFallback(question, data, workspaceDir)
  const results = Array.isArray(augmented.results) ? augmented.results : []

  return {
    ...result,
    provenance: results.length > 0 ? formatReadDocumentSourceIds(results) : result.provenance,
    data: {
      ...data,
      ...augmented,
      total: results.length,
    },
  }
}

function buildDeterministicIntentAnswer(
  question: string,
  results: ReadDocumentsResultItem[]
): string | undefined {
  const normalizedQuestion = question.toLowerCase().trim()
  const highRecall = requiresHighRecallQuery(normalizedQuestion)
  const queryTokens = tokenizeForEvidence(question)
  const broadQuestion = queryTokens.length <= 5 && /^(what|how|why)\b/i.test(question.trim())

  let best:
    | {
        line: string
        sourceId: string
        score: number
      }
    | undefined

  for (const item of results.slice(0, 10)) {
    const sourceId = item.metadata?.id ?? 'unknown-doc'
    const sourceTitle = item.metadata?.title ?? ''
    const sourceText = `${sourceId} ${sourceTitle}`.toLowerCase()
    const significantTokens = queryTokens.filter(token => token.length >= 4)
    const sourceMatchCount = significantTokens.reduce(
      (count, token) => count + (sourceText.includes(token) ? 1 : 0),
      0
    )
    const sourceBoost = sourceMatchCount >= 2 ? sourceMatchCount * 2 : 0
    const lines = (item.content ?? '')
      .split('\n')
      .map(line => line.trim().replace(/^[-*]\s+/, ''))
      .filter(
        line =>
          line.length >= 20 &&
          line.length <= 260 &&
          !/^#\s/.test(line) &&
          !line.startsWith('Created:') &&
          !line.startsWith('Tags:') &&
          !line.startsWith('Type:') &&
          !line.includes('->') &&
          !/\|".*"\|/.test(line) &&
          !/<\/?[a-z][^>]*>/i.test(line)
      )

    for (const line of lines) {
      const normalizedLine = line.toLowerCase()
      const lineTokenMatches = queryTokens.reduce(
        (count, token) => count + (normalizedLine.includes(token) ? 1 : 0),
        0
      )
      if (normalizedLine.includes(normalizedQuestion)) {
        return `${line} (source: ${sourceId})`
      }
      if (lineTokenMatches === 0 && sourceMatchCount === 0) {
        continue
      }

      let score = scoreEvidenceLine(line, queryTokens) + sourceBoost
      if (
        /(help cleanup|regression tests|unknown-command fallback|--help now prints|smoke runs)/i.test(
          line
        )
      ) {
        score -= 4
      }
      if (/(<li>|<\/li>|<ul>|<\/ul>)/i.test(line)) {
        score -= 4
      }
      if (broadQuestion && /^(kb|cli)\b/i.test(line)) {
        score += 2
      }
      if (line.length > 35 && line.length < 220) {
        score += 1
      }

      if (!best || score > best.score) {
        best = { line, sourceId, score }
      }
    }
  }

  if (!best) return undefined
  if (highRecall && best.score < 4) return undefined
  if (best.score <= 0) return undefined
  return `${best.line} (source: ${best.sourceId})`
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

export function isReadDocumentsResult(result: IntentResult): boolean {
  return result.recommendedAction === 'read_documents' && result.status === 'accepted'
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
    `Decision: re-run submit with ${acceptFlag} to apply changes, or ${passFlag} to skip propagation.`
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

  if (verbose) {
    lines.push(formatOrchestrationMetaLine('summary', buildSummary(results)))
    lines.push(formatOrchestrationMetaLine('status', result.status))
    if (typeof result.confidence === 'number') {
      lines.push(formatOrchestrationMetaLine('confidence', result.confidence.toFixed(2)))
    }
  }

  if (data.retrieval?.method) {
    const detail = data.retrieval.detail ? ` (${data.retrieval.detail})` : ''
    lines.push(formatOrchestrationMetaLine('retrieval', `${data.retrieval.method}${detail}`))
  }

  lines.push(formatOrchestrationMetaLine('matches', String(results.length)))
  appendReadDocumentsSourcesToLines(lines, results, options)

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
  printReadDocumentsOrchestrationFooter(printer, result, options)
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
  return candidateLines[0]
}

export function resolveReadDocumentsAnswer(result: IntentResult): string | undefined {
  if (!isReadDocumentsResult(result)) return undefined
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  return data.answer?.trim() || buildAnswer(results)
}

export function resolveReadDocumentsAnswerForQuestion(
  result: IntentResult,
  question: string
): string | undefined {
  if (!isReadDocumentsResult(result)) return undefined
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  return (
    data.answer?.trim() || buildDeterministicIntentAnswer(question, results) || buildAnswer(results)
  )
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

function buildEvidence(results: ReadDocumentsResultItem[], query: string): string {
  const sections = results.slice(0, 5).map((item, index) => {
    const id = item.metadata?.id ?? `doc-${index + 1}`
    const title = item.metadata?.title ?? id
    const snippets = extractRelevantEvidenceSnippets(item.content, query)
    if (snippets.length === 0) return ''
    return `Document ${index + 1}: ${title} (id=${id})\n${snippets.join('\n')}`
  })

  const graphHints = new Set<string>()
  for (const item of results.slice(0, 5)) {
    for (const line of item.graphEvidence ?? []) {
      if (line.trim()) graphHints.add(line.trim())
    }
  }
  const graphBlock =
    graphHints.size > 0
      ? `\n\nGraph linkage hints (typed edges in the KB graph; must agree with document text above):\n${[...graphHints].map(h => `- ${h}`).join('\n')}`
      : ''

  return sections.filter(Boolean).join('\n\n') + graphBlock
}

function extractRelevantEvidenceSnippets(content: string | undefined, query: string): string[] {
  if (!content?.trim()) return []

  const queryTokens = tokenizeForEvidence(query)
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

  const commandWords = ['kb', 'cli', 'command', 'query', 'submit', 'invalidate', 'chat', 'help']
  const queryHasCommandWord = commandWords.some(token => queryTokens.includes(token))
  if (queryHasCommandWord && /(kb|cli|command|query|submit|invalidate|chat|help)/i.test(line)) {
    score += 1
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
      .filter(
        line =>
          line.length > 0 &&
          !/^#\s/.test(line) &&
          !line.startsWith('Created:') &&
          !line.startsWith('Tags:') &&
          !line.startsWith('Type:') &&
          !line.includes('->') &&
          !/\|".*"\|/.test(line)
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
  if (/(precedence|order)/i.test(line)) score += 3
  if (/(1\)|2\)|3\)|->)/i.test(line)) score += 5
  if (/^(kb|cli|query|hybrid|sqlite)/i.test(line)) score += 2
  if (
    /(help cleanup|regression tests|unknown-command fallback|--help now prints|smoke runs)/i.test(
      line
    )
  )
    score -= 6
  if (line.includes('--help')) score -= 3
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
        !/^#\s/.test(line) &&
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
      line.startsWith('#') ||
      line.startsWith('Created:') ||
      line.startsWith('Tags:') ||
      line.startsWith('Type:')
    ) {
      continue
    }

    const excerpt = line.length <= 110 ? line : `${line.slice(0, 107)}...`
    highlights.push({ section: activeSection, excerpt })
    if (highlights.length >= 2) break
  }

  return highlights
}

export function printIntentHelp(mode: CmdMode = 'cli'): string {
  return [
    'Intent commands:',
    `  ${cmd('submit "<fact>" [--base <name>] [--domain ops] [--source runbook] [--include-session-logs] [--output human|json]', mode)}`,
    `  ${cmd('query "<topic>" [--base <name>] [--limit 5] [--type decision] [--discovery shallow|deep] [--session] [--verbose] [--debug] [--output human|json]', mode)}`,
    `  ${cmd('invalidate "<old-fact>" ["<replacement-fact>"] [--base <name>] [--preview|--dry-run] [--output human|json]', mode)}`,
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

function readOptionalPositional(args: string[], index: number): string | undefined {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const value = positional[index]
  return value || undefined
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
    case 'query':
      return 'query_truth'
    case 'invalidate':
      return 'invalidate_fact'
    default:
      throw new Error(`Unsupported command: ${command}`)
  }
}
