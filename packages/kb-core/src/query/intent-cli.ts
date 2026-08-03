import dayjs from 'dayjs'
import { formatEvidenceSummaryHeader } from '@kb/core/core/evidence-summary.js'
import {
  formatRetrievedFactsForLLM,
  MAX_FACT_CONTENT_CHARS,
} from '@kb/core/core/retrieval-context.js'
import { type LLMFailure, emptyResponseFailure, toLLMFailure } from '@kb/core/core/llm-error.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider, Message } from '@kb/core/core/types.js'
import { assertConsumerSafeCommand } from '@kb/core/intents/policy.js'
import { DefaultIntentRouter } from '@kb/core/intents/router.js'
import type {
  ConsumerIntent,
  ConsumerIntentEnvelope,
  IntentResult,
} from '@kb/core/intents/types.js'
import { formatOrchestrationMetaLine } from '../ui/orchestration-meta.js'
import { PROCEDURAL_SYNTHESIS_GUIDANCE, isProceduralQuestion } from './procedural-intent.js'

/** Minimal printer surface for intent result rendering (implemented by client Printer). */
export interface IntentResultPrinter {
  content(text: string): void
  metadata(label: string, value: string): void
  separator(): void
  orchestrationMeta(label: string, value: string): void
}
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import { appendQuerySession, loadQuerySessionMessages } from './query-session.js'
import { formatReadDocumentSourcesPreview } from './retrieval-fallback.js'

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
  /** When true (`kb query --trace`), enable the opt-in deep query trace dump. */
  trace?: boolean
}

/** Human read_facts footer: default minimal; verbose adds summary/status/confidence. */
export interface ReadDocumentsHumanOutputOptions {
  verbose?: boolean
}

const INTENT_COMMANDS = new Set(['query'])
/** Visible answer output budget for kb query synthesis. Override via KB_QUERY_MAX_OUTPUT_TOKENS. */
const INTENT_LLM_MAX_OUTPUT_TOKENS = (() => {
  const n = Number(process.env.KB_QUERY_MAX_OUTPUT_TOKENS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32_768
})()

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
  const trace = readFlag(rest, '--trace')
  // Local mode reads KB_QUERY_TRACE at run time; surface the flag as that env var here.
  if (trace) {
    process.env.KB_QUERY_TRACE = 'true'
  }

  let envelope: ConsumerIntentEnvelope

  switch (command) {
    case 'query':
      envelope = {
        intent: 'query_truth',
        requestId: `req-${dayjs().valueOf()}`,
        payload: {
          query: readPositional(rest, 0, 'query requires a topic/query string'),
          discoveryDepth: parseDiscoveryDepth(readOption(rest, '--discovery')),
        },
      }
      break

    default:
      throw new Error(`Unsupported intent command: ${command}`)
  }

  const useQuerySession = command === 'query' && readFlag(rest, '--session')
  const allFacts = command === 'query' && readFlag(rest, '--all-facts')

  return { envelope, base, verbose, useQuerySession, allFacts, trace }
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
  if (result.evidence) {
    lines.push(formatOrchestrationMetaLine('evidence', result.evidence))
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
  printer: IntentResultPrinter,
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
  if (result.evidence) {
    printer.metadata('Evidence', result.evidence)
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
    /** Physical source file the fact was extracted from, when resolvable. */
    sourcePath?: string
    /** Origin repo slug (`facts.git_repo` / clone dir name). */
    gitRepo?: string
    /** For code facts, the exported symbol the fact describes. */
    symbol?: string
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
    /**
     * Out-of-band curator audit (kept/dropped/re-queried). Surfaced to synthesis as
     * "research notes" framing — never quoted as fact. See `formatCuratorResearchNotes`.
     */
    curation?: CuratorAudit
    /**
     * Best-effort stages (scope inference, graph rerank, sufficiency judge, curation)
     * that failed on an LLM/transport error and were skipped. Retrieval still
     * succeeded, so these never block an answer — but they must not be invisible,
     * or an outage reads as a quality regression.
     */
    degraded?: LLMFailure[]
  }
  /**
   * Set when answer synthesis was attempted and did not produce an answer. Absent
   * `answer` alone is ambiguous — it could mean the provider errored, the model
   * returned nothing, or synthesis was never requested. Callers must be able to
   * tell an outage from a genuine "nothing to say".
   */
  answerError?: LLMFailure
  /** Path to the opt-in deep trace dump when `kb query --trace` ran. */
  traceFile?: string
}

/** Subset of the curator's {@link CurationRecord} consumed by synthesis framing. */
export interface CuratorAudit {
  evaluated?: number
  dropped?: unknown[]
  added?: number
  requeried?: string[]
  sufficient?: boolean
  /** True when the curator bailed to its safe fallback — no judging actually happened. */
  fellBack?: boolean
}

/**
 * Render the curator's self-assessment as a short framing note for synthesis. This is the
 * "comments in the loop" signal: it tells the model how focused the evidence is and which gaps
 * the retrieval could not close, so the answer is written from a thesis rather than a flat pile.
 * Returns '' when no curation ran. The note is framing only — the prompt forbids quoting it as fact.
 */
export function formatCuratorResearchNotes(curation: CuratorAudit | undefined): string {
  if (!curation) return ''
  // The curator bailed (LLM error / empty-result guard), so no judging happened. Claiming
  // the evidence was "focused" here would be a fabricated process claim in the synthesis
  // prompt — the one place a false statement turns into a false answer.
  if (curation.fellBack) return ''
  const evaluated = typeof curation.evaluated === 'number' ? curation.evaluated : undefined
  const droppedCount = Array.isArray(curation.dropped) ? curation.dropped.length : 0
  const added = typeof curation.added === 'number' ? curation.added : 0
  const lines: string[] = []
  if (evaluated !== undefined) {
    const kept = Math.max(0, evaluated - droppedCount) + added
    const droppedNote = droppedCount > 0 ? ` (dropped ${droppedCount} off-topic).` : '.'
    lines.push(
      `- Focused the evidence to the ${kept} fact(s) most relevant to the question${droppedNote}`
    )
  }
  const gaps = Array.isArray(curation.requeried)
    ? curation.requeried.filter(g => typeof g === 'string' && g.trim().length > 0)
    : []
  if (curation.sufficient === false && gaps.length > 0) {
    lines.push(`- Gaps retrieval could not fully close: ${gaps.join('; ')}.`)
  } else if (curation.sufficient === true) {
    lines.push('- The retrieved evidence was judged sufficient to answer.')
  }
  if (lines.length === 0) return ''
  return [
    'Research notes (retrieval self-assessment — use as framing for how confident/complete to be, NOT as facts to quote):',
    ...lines,
  ].join('\n')
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
  printer: IntentResultPrinter,
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
  printer: IntentResultPrinter,
  result: IntentResult,
  options?: ReadDocumentsHumanOutputOptions
): void {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  const verbose = options?.verbose === true

  if (verbose) {
    printer.metadata('Summary', buildSummary(results))
    printer.metadata('Status', result.status)
    if (result.evidence) {
      printer.metadata('Evidence', result.evidence)
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
  options?: {
    graphRelationContext?: string
    synthesisQuestion?: string
    /** Stream the model's reasoning tokens for a transient "loading" display. */
    onReasoning?: (delta: string) => void
  }
): Promise<IntentResult> {
  if (!llmProvider) return result
  if (!isReadFactsResult(result)) return result
  if (process.env.KB_INTENT_LLM_ANSWER === 'false') return result

  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return result

  // Pre-expansion user question — graph-expanded payload.query must not drive synthesis/scaffold.
  const question = options?.synthesisQuestion?.trim() || getIntentQuestion(parsed)
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

    const researchNotes = formatCuratorResearchNotes(data.retrieval?.curation)

    const proceduralGuidance = isProceduralQuestion(question) ? PROCEDURAL_SYNTHESIS_GUIDANCE : ''

    const userContent = [
      'Answer from the evidence below. Use only the facts that bear on the question and ignore the rest — do not pad the answer with loosely related facts. Always give a useful response: a high-level summary for broad questions, precise detail for specific ones. Only say evidence is insufficient if the question is completely unrelated to anything retrieved.',
      'Match the answer structure to the question. For a multi-part or comparative question, lead with the direct answer, then break the supporting detail into short headings, bullets, or a compact table so each part is answerable at a glance; bold key terms (settings, file names, flags, conditions). For a simple question, a tight paragraph is enough.',
      'When a claim rests on a specific file, function, or setting, name it inline (e.g. `reports.ts`, `directDownlineDataAccess`) so the reader can verify it. Do not invent fact ids, do not cite evidence as "Document N", and do not append a separate "Sources:"/"Citations:" list — weave concrete identifiers into the prose where they help.',
      'Only name files that actually appear in the evidence, copying their paths exactly — never guess, alias, or abbreviate a file name the evidence does not show. If the evidence does not reveal which file holds something, say so instead of inventing a plausible file name.',
      'If the question asks kb to perform a capability it does not have (provision infrastructure, deploy unrelated services, etc.), lead with a brief boundary answer — do not substitute a long guide to a different task just because retrieved facts share words like "deploy" or "kubernetes".',
      ...(proceduralGuidance ? ['', proceduralGuidance] : []),
      '',
      `Question: ${question}`,
      graphSection,
      researchNotes ? `\n${researchNotes}` : '',
      '',
      `Evidence:\n${evidence}`,
    ].join('\n')

    const completion = await llmProvider.call({
      messages: [...contextMessages, { role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: INTENT_LLM_MAX_OUTPUT_TOKENS,
      ...(options?.onReasoning ? { onReasoning: options.onReasoning } : {}),
    })

    let answer = completion.text.trim()
    if (!answer) return withAnswerError(result, emptyResponseFailure('synthesis', llmProvider.name))

    if (looksLikeInsufficientEvidenceAnswer(answer)) {
      answer = buildDeterministicIntentAnswer(question, results) ?? ''
      if (!answer)
        return withAnswerError(result, emptyResponseFailure('synthesis', llmProvider.name))
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
  } catch (error) {
    // A provider outage (429, spent credits, bad key, 5xx, timeout) must never look
    // like "the KB had nothing to say". Keep the retrieval results — they are still
    // real and useful — but record why no answer came back.
    return withAnswerError(result, toLLMFailure('synthesis', error, llmProvider.name))
  }
}

/**
 * Attach a synthesis failure to a retrieval result without disturbing anything else.
 *
 * `status` deliberately stays `accepted`: {@link isReadFactsResult} gates on it, and
 * flipping it here would strip sources from chat replies and skip re-synthesis on
 * retry. The failure travels as data, not as a status change.
 */
function withAnswerError(result: IntentResult, failure: LLMFailure): IntentResult {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  return {
    ...result,
    data: { ...data, answerError: failure },
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
  const trimmed = answer.trim()
  // Structured synthesis uses headings/bullets — do not clobber a substantive answer.
  if (trimmed.length >= 400) return false
  if (/^#{1,3}\s/m.test(trimmed) || /^\s*[-*]\s+\S/m.test(trimmed)) return false
  const normalized = trimmed.toLowerCase()
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
  if (/\bbuild config(uration)?\b/.test(normalized)) return true
  if (/\b(cmake|makefile|toolchain)\b/.test(normalized)) return true
  if (
    /\bhow (?:do i|to)\b/.test(normalized) &&
    /\b(install|build|compile|configure)\b/.test(normalized)
  ) {
    return true
  }
  return /\b(configuration options|compile flags|build settings|build systems?)\b/.test(normalized)
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
    if (result.evidence) {
      lines.push(formatOrchestrationMetaLine('evidence', result.evidence))
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
  printer: IntentResultPrinter,
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
  printer: IntentResultPrinter,
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

export function getIntentQuestion(parsed: ParsedIntentCommand): string {
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
    maxContentChars: MAX_FACT_CONTENT_CHARS,
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
    `  ${cmd('query "<topic>" [--base <name>] [--discovery shallow|deep] [--session] [--verbose] [--trace]', mode)}`,
  ].join('\n')
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
