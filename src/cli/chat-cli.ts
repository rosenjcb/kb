import { createInterface } from 'node:readline/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider } from '../core/types'
import type { DuckGraphWriter } from '../tools/duck-graph-writer'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  graphWriter?: DuckGraphWriter
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
}

export interface ChatIO {
  read(prompt: string): Promise<string | null>
  write(line: string): void
  error(line: string): void
  close?(): void
}

interface ChatTurn {
  user: string
  assistant: string
}

interface ReadDocumentsResult {
  results?: Array<{
    metadata?: {
      id?: string
    }
    content?: string
  }>
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

type ReadDocumentsCheckpoint = {
  stage?: string
  status?: string
  nextAction?: string
  confidence?: number
}

const HELP_TEXT = [
  'assistant> Commands:',
  'assistant>   /help  Show chat commands',
  'assistant>   /exit  Exit chat mode',
].join('\n')

export function printChatHelp(): string {
  return [
    'kb chat',
    '',
    'Usage:',
    '  kb chat',
    '',
    'Interactive commands:',
    '  /help  Show chat commands',
    '  /exit  Exit chat mode',
    '',
    'Examples:',
    '  kb chat',
  ].join('\n')
}

export async function runChatSession(deps: ChatSessionDeps, io: ChatIO = createTerminalChatIO()): Promise<void> {
  const retrievalLimit = deps.retrievalLimit ?? 5
  const maxHistoryTurns = deps.maxHistoryTurns ?? 4
  const history: ChatTurn[] = []

  io.write('assistant> Chat mode started. Type /help for commands.')

  try {
    while (true) {
      const rawInput = await io.read('you> ')
      if (rawInput === null) {
        io.write('assistant> Exiting chat.')
        break
      }

      const input = rawInput.trim()
      if (!input) continue

      if (input === '/help') {
        io.write(HELP_TEXT)
        continue
      }

      if (input === '/exit') {
        io.write('assistant> Exiting chat.')
        break
      }

      try {
        const highRecall = requiresHighRecallQuestion(input)
        const expandedQuery = deps.graphWriter
          ? await expandQueryWithGraph(input, deps.graphWriter)
          : input
        const readResult = await deps.toolExecutor.execute({
          id: `chat-read-${Date.now()}`,
          name: 'read_documents',
          input: {
            query: expandedQuery,
            mode: 'content',
            discoveryDepth: highRecall ? 'deep' : 'shallow',
            includeContent: true,
            limit: highRecall ? Math.max(retrievalLimit * 2, 12) : retrievalLimit,
          },
        })

        let retrieval = normalizeReadResult(readResult)

        if (shouldAttemptRecoveryQuery(retrieval)) {
          const recoveryQuery = buildRecoveryQuery(input)
          if (recoveryQuery) {
            const recoveryResult = await deps.toolExecutor.execute({
              id: `chat-read-recovery-${Date.now()}`,
              name: 'read_documents',
              input: {
                query: recoveryQuery,
                includeContent: true,
                limit: retrievalLimit,
              },
            })

            retrieval = mergeReadResults(retrieval, normalizeReadResult(recoveryResult), 'chat-recovery-retry')
          }
        }

        const retrievalWithFallback = await augmentRetrievalWithWorkspaceFallback(
          input,
          retrieval,
          deps.workspaceDir ?? process.cwd(),
        )
        let retrievalForOutput = retrievalWithFallback
        const prompt = buildChatPrompt({
          question: input,
          retrieval: retrievalForOutput,
          history,
        })

        const completion = await deps.llmProvider.call({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
          maxTokens: 320,
        })

        const llmAnswer = completion.text.trim()
        let answer = chooseChatAnswer(
          llmAnswer,
          buildDeterministicFallbackAnswer(input, retrievalWithFallback.results),
        )

        if (looksLikeInsufficientEvidenceAnswer(answer)) {
          const deepResult = await deps.toolExecutor.execute({
            id: `chat-read-deep-${Date.now()}`,
            name: 'read_documents',
            input: {
              query: input,
              mode: 'content',
              discoveryDepth: 'deep',
              includeContent: true,
              limit: Math.max(retrievalLimit * 3, 12),
            },
          })

          const deepRetrieval = normalizeReadResult(deepResult)
          retrievalForOutput = mergeReadResults(
            retrievalForOutput,
            deepRetrieval,
            'chat-deep-discovery-promotion',
          )

          const deepFallback = buildDeterministicFallbackAnswer(input, deepRetrieval.results)
          if (deepFallback) {
            answer = deepFallback
          }
        }

        if (looksLikeInsufficientEvidenceAnswer(answer)) {
          const focusedQuery = buildFocusedEvidenceQuery(input)
          if (focusedQuery) {
            const focusedResult = await deps.toolExecutor.execute({
              id: `chat-read-focused-${Date.now()}`,
              name: 'read_documents',
              input: {
                query: focusedQuery,
                includeContent: true,
                limit: retrievalLimit,
              },
            })

            const focused = normalizeReadResult(focusedResult)
            const focusedFallback = buildDeterministicFallbackAnswer(input, focused.results)
            if (focusedFallback) {
              answer = focusedFallback
              retrievalForOutput = mergeReadResults(retrievalForOutput, focused, 'chat-post-answer-recovery')
            }
          }
        }

        if (looksLikeInsufficientEvidenceAnswer(answer)) {
          answer = 'I do not have enough grounded evidence yet. Try: kb query "<your fact>" --discovery deep --output json and then kb submit "<fact>" if it is missing.'
        }

        io.write(`assistant> ${answer}`)
        io.write(`retrieval> ${formatRetrievalMode(retrievalForOutput.retrieval)}`)
        const checkpointTrace = formatCheckpointTrace(retrievalForOutput.retrieval)
        if (checkpointTrace) {
          io.write(`checkpoints> ${checkpointTrace}`)
        }
        io.write(`sources> ${formatSourceIds(retrievalForOutput.results).join(', ') || 'none'}`)

        history.push({ user: input, assistant: answer })
        if (history.length > maxHistoryTurns) {
          history.splice(0, history.length - maxHistoryTurns)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        io.error(`error> Chat turn failed: ${message}`)
      }
    }
  } finally {
    io.close?.()
  }
}

export function buildChatPrompt(input: {
  question: string
  retrieval: ReadDocumentsResult
  history: ChatTurn[]
}): string {
  const evidence = buildEvidence(input.retrieval.results)
  const historyText = input.history.length
    ? input.history
      .map((turn, index) => `Turn ${index + 1} user: ${turn.user}\nTurn ${index + 1} assistant: ${turn.assistant}`)
      .join('\n\n')
    : 'No prior turns.'

  return [
    'You are a KB assistant.',
    'Answer only with support from the evidence below.',
    'Prefer direct factual statements from retrieved evidence when available.',
    'If evidence is weak or missing after checking the retrieved lines, say that explicitly and suggest what to query next.',
    '',
    `Conversation history:\n${historyText}`,
    '',
    `Retrieved evidence:\n${evidence}`,
    '',
    `Current user question: ${input.question}`,
  ].join('\n')
}

function chooseChatAnswer(llmAnswer: string, fallbackAnswer: string | undefined): string {
  if (!llmAnswer) {
    return fallbackAnswer ?? 'I do not have enough evidence to answer that yet.'
  }

  if (fallbackAnswer && looksLikeInsufficientEvidenceAnswer(llmAnswer)) {
    return fallbackAnswer
  }

  return llmAnswer
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
    || normalized.includes('would need additional information')
    || normalized.includes('further specific queries')
  )
}

function requiresHighRecallQuestion(question: string): boolean {
  const trimmed = question.trim()
  if (!trimmed) return false

  const tokenLike = /^[A-Z0-9._-]{16,}$/.test(trimmed)
  if (tokenLike) return true

  if (trimmed.length >= 20 && (trimmed.includes('_') || trimmed.includes('-'))) {
    return true
  }

  return false
}

function buildFocusedEvidenceQuery(question: string): string | undefined {
  const tokens = tokenizeQuestion(question)
  if (tokens.length === 0) return undefined

  const isCliQuestion = tokens.some(token =>
    ['kb', 'cli', 'command', 'commands', 'tool', 'tools', 'submit', 'query', 'validate', 'dispute', 'chat', 'help'].includes(token),
  )

  if (isCliQuestion) {
    const preferredOrder = ['kb', 'cli', 'command', 'commands', 'query', 'submit', 'validate', 'dispute', 'chat', 'help']
    const preferred = preferredOrder.filter(token => tokens.includes(token))
    if (preferred.length >= 2) {
      return preferred.slice(0, 4).join(' ')
    }
  }

  const phrase = extractQuestionPhrases(tokens)[0]
  if (phrase) {
    return phrase
  }

  return tokens.slice(0, 4).join(' ')
}

function buildDeterministicFallbackAnswer(
  question: string,
  results: ReadDocumentsResult['results'],
): string | undefined {
  const candidate = extractBestEvidenceLine(question, results)
  if (!candidate) return undefined
  return `${candidate.line} (source: ${candidate.docId})`
}

function extractBestEvidenceLine(
  question: string,
  results: ReadDocumentsResult['results'],
): { line: string; docId: string } | undefined {
  if (!Array.isArray(results) || results.length === 0) return undefined

  const tokens = tokenizeQuestion(question)
  const phrases = extractQuestionPhrases(tokens)
  const normalizedQuestion = question.toLowerCase().trim()
  const highRecall = requiresHighRecallQuestion(question)
  let best: { line: string; docId: string; score: number } | undefined

  for (const result of results.slice(0, 5)) {
    const docId = result.metadata?.id ?? 'unknown-doc'
    const lines = (result.content ?? '')
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
      const cleanLine = line.replace(/^[-*]\s+/, '').trim()
      if (!cleanLine) continue

      if (highRecall && !cleanLine.toLowerCase().includes(normalizedQuestion)) {
        continue
      }

      const score = scoreLineForQuestion(cleanLine, tokens, phrases)
      if (score < 2) continue

      if (!best || score > best.score) {
        best = { line: cleanLine, docId, score }
      }
    }
  }

  if (!best) return undefined
  return { line: best.line, docId: best.docId }
}

function tokenizeQuestion(question: string): string[] {
  const stopwords = new Set([
    'what', 'which', 'when', 'where', 'who', 'why', 'how',
    'current', 'there', 'any', 'still', 'present', 'cite',
    'document', 'documents', 'used', 'older', 'older', 'older',
    'and', 'the', 'that', 'this', 'with', 'from', 'into', 'about',
  ])

  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1)
    .filter(token => !stopwords.has(token))
}

function extractQuestionPhrases(tokens: string[]): string[] {
  const phrases: string[] = []
  for (let i = 0; i < tokens.length - 1; i += 1) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return phrases
}

function scoreLineForQuestion(line: string, tokens: string[], phrases: string[]): number {
  const normalized = line.toLowerCase()
  let score = 0

  const isCliQuestion = tokens.some(token =>
    ['kb', 'cli', 'command', 'commands', 'tool', 'tools', 'submit', 'query', 'validate', 'dispute', 'chat', 'help'].includes(token),
  )

  for (const token of tokens) {
    if (normalized.includes(token)) score += 1
  }

  for (const phrase of phrases) {
    if (normalized.includes(phrase)) score += 4
  }

  if (/\b(is|are|requires|uses|must|should|cannot|does not)\b/.test(normalized)) {
    score += 1
  }

  if (isCliQuestion && /(kb\s+--help|kb\s+query|kb\s+submit|kb\s+validate|kb\s+dispute|kb\s+explain|kb\s+chat|cli quick-reference)/.test(normalized)) {
    score += 4
  }

  if (isCliQuestion && /(submit\/query\/validate\/dispute\/explain)/.test(normalized)) {
    score += 3
  }

  if (/(kb|cli|query|chat|lane-routing|sqlite)/.test(normalized) && !tokens.some(token => ['kb', 'cli', 'query', 'chat', 'sqlite'].includes(token))) {
    score -= 1
  }

  return score
}

function normalizeReadResult(value: unknown): ReadDocumentsResult {
  if (!value || typeof value !== 'object') {
    return { results: [] }
  }

  const candidate = value as ReadDocumentsResult
  const results = Array.isArray(candidate.results) ? candidate.results : []
  return {
    results,
    retrieval: candidate.retrieval,
  }
}

async function augmentRetrievalWithWorkspaceFallback(
  question: string,
  retrieval: ReadDocumentsResult,
  workspaceDir: string,
): Promise<ReadDocumentsResult> {
  if (!shouldUseWorkspaceFallback(question, retrieval)) {
    return retrieval
  }

  const fallbackResults = await loadWorkspaceFallbackResults(workspaceDir)
  if (fallbackResults.length === 0) {
    return retrieval
  }

  return {
    ...retrieval,
    results: [...(retrieval.results ?? []), ...fallbackResults].slice(0, 8),
    retrieval: {
      method: retrieval.retrieval?.method ?? 'lexical',
      detail: appendDetail(retrieval.retrieval?.detail, 'workspace-fallback'),
      checkpoints: retrieval.retrieval?.checkpoints,
    },
  }
}

function shouldUseWorkspaceFallback(
  question: string,
  retrieval: ReadDocumentsResult,
): boolean {
  if (!isBroadProjectQuestion(question)) {
    return false
  }

  const results = retrieval.results

  if (!results || results.length === 0) {
    return true
  }

  const confidence = getFinalCheckpointConfidence(retrieval)
  if (typeof confidence === 'number' && confidence < 0.72) {
    return true
  }

  const ids = formatSourceIds(results)
  if (ids.length === 0) {
    return true
  }

  return ids.every(isLowSignalSourceId)
}

function isLowSignalSourceId(id: string): boolean {
  return id.startsWith('ticket-')
    || id.startsWith('session-log-')
    || id === 'general-facts'
}

function isBroadProjectQuestion(question: string): boolean {
  const text = question.toLowerCase()
  return /(what is this project|what is this repo|project about|purpose|goal|mission|scope)/.test(text)
}

async function loadWorkspaceFallbackResults(
  workspaceDir: string,
): Promise<NonNullable<ReadDocumentsResult['results']>> {
  const docs = [
    { id: 'workspace-readme', fileName: 'README.md' },
    { id: 'workspace-gameplan', fileName: 'GAMEPLAN.md' },
  ]

  const results: NonNullable<ReadDocumentsResult['results']> = []

  for (const doc of docs) {
    try {
      const filePath = path.join(workspaceDir, doc.fileName)
      const content = await readFile(filePath, 'utf8')
      const clipped = content.length > 1800 ? `${content.slice(0, 1800)}...` : content
      results.push({
        metadata: { id: doc.id },
        content: clipped,
      })
    } catch {
      // Best-effort fallback: skip missing files.
    }
  }

  return results
}

function appendDetail(base: string | undefined, suffix: string): string {
  if (!base) return suffix
  return `${base};${suffix}`
}

function shouldAttemptRecoveryQuery(retrieval: ReadDocumentsResult): boolean {
  const finalCheckpoint = getFinalCheckpoint(retrieval)
  if (!finalCheckpoint) {
    return !retrieval.results || retrieval.results.length === 0
  }

  if (finalCheckpoint.nextAction === 'advance') return true
  if (finalCheckpoint.status === 'error' || finalCheckpoint.status === 'miss') return true
  if (typeof finalCheckpoint.confidence === 'number' && finalCheckpoint.confidence < 0.45) {
    return true
  }

  return false
}

function buildRecoveryQuery(input: string): string | undefined {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return undefined

  const tokens = normalized
    .split(' ')
    .filter(token => token.length >= 3)
    .slice(0, 8)

  if (tokens.length === 0) return undefined
  return tokens.join(' ')
}

function mergeReadResults(
  primary: ReadDocumentsResult,
  secondary: ReadDocumentsResult,
  detailSuffix: string,
): ReadDocumentsResult {
  const mergedMap = new Map<string, { metadata?: { id?: string }; content?: string }>()

  for (const result of primary.results ?? []) {
    const id = result.metadata?.id ?? `primary-${mergedMap.size}`
    mergedMap.set(id, result)
  }

  for (const result of secondary.results ?? []) {
    const id = result.metadata?.id ?? `secondary-${mergedMap.size}`
    if (!mergedMap.has(id)) {
      mergedMap.set(id, result)
    }
  }

  const checkpoints = [
    ...(primary.retrieval?.checkpoints ?? []),
    ...(secondary.retrieval?.checkpoints ?? []),
  ]

  return {
    results: [...mergedMap.values()].slice(0, 8),
    retrieval: {
      method: secondary.retrieval?.method ?? primary.retrieval?.method,
      detail: appendDetail(
        secondary.retrieval?.detail ?? primary.retrieval?.detail,
        detailSuffix,
      ),
      checkpoints,
    },
  }
}

function getFinalCheckpoint(
  retrieval: ReadDocumentsResult,
): ReadDocumentsCheckpoint | undefined {
  const checkpoints = retrieval.retrieval?.checkpoints
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return undefined
  return checkpoints[checkpoints.length - 1]
}

function getFinalCheckpointConfidence(retrieval: ReadDocumentsResult): number | undefined {
  const checkpoint = getFinalCheckpoint(retrieval)
  return checkpoint?.confidence
}

function formatRetrievalMode(retrieval: ReadDocumentsResult['retrieval']): string {
  const method = retrieval?.method ?? 'unknown'
  const detail = retrieval?.detail ? ` (${retrieval.detail})` : ''
  return `${method}${detail}`
}

function formatCheckpointTrace(retrieval: ReadDocumentsResult['retrieval']): string | undefined {
  const checkpoints = retrieval?.checkpoints
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return undefined
  }

  return checkpoints
    .map(checkpoint => {
      const stage = checkpoint.stage ?? 'unknown-stage'
      const status = checkpoint.status ?? 'unknown-status'
      const action = checkpoint.nextAction ?? 'unknown-action'
      return `${stage}:${status}->${action}`
    })
    .join(' | ')
}

function formatSourceIds(results: ReadDocumentsResult['results']): string[] {
  if (!Array.isArray(results) || results.length === 0) return []

  const ids = results
    .map(result => result.metadata?.id)
    .filter((value): value is string => Boolean(value))

  return [...new Set(ids)].slice(0, 10)
}

function buildEvidence(results: ReadDocumentsResult['results']): string {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No evidence retrieved from KB documents.'
  }

  const sections: string[] = []

  for (const [index, result] of results.slice(0, 4).entries()) {
    const docId = result.metadata?.id ?? `doc-${index + 1}`
    const content = (result.content ?? '').trim()
    const snippet = content.length > 900 ? `${content.slice(0, 900)}...` : content
    sections.push(`Document ${index + 1} (${docId}):\n${snippet || 'No content available.'}`)
  }

  return sections.join('\n\n')
}

export function createTerminalChatIO(): ChatIO {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  let interrupted = false
  const onSigint = () => {
    interrupted = true
    rl.close()
  }

  rl.on('SIGINT', onSigint)

  return {
    async read(prompt: string): Promise<string | null> {
      if (interrupted) return null

      try {
        return await rl.question(prompt)
      } catch {
        return null
      }
    },
    write(line: string) {
      console.log(line)
    },
    error(line: string) {
      console.error(line)
    },
    close() {
      rl.off('SIGINT', onSigint)
      try {
        rl.close()
      } catch {
        // Interface may already be closed.
      }
    },
  }
}
