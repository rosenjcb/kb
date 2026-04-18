import { createInterface } from 'node:readline/promises'
import { loadPrompt } from '../prompts/loader'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message } from '../core/types'
import type { DuckGraphWriter } from '../tools/duck-graph-writer'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import {
  type ChatConversationState,
  createInitialConversationState,
  resolveConversationalChatTurn,
  updateConversationState,
} from './chat-conversation'
import { type CmdMode, cmd } from './cmd-ref'
import {
  appendRetrievalDetail,
  augmentReadDocumentsWithWorkspaceFallback,
  formatReadDocumentSourceIds,
} from './retrieval-fallback'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  graphWriter?: DuckGraphWriter
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
  conversationalRetrieval?: boolean
  onTurnComplete?: (turn: ChatTurnTrace) => void
}

export interface ChatIO {
  read(prompt: string): Promise<string | null>
  write(line: string): void
  error(line: string): void
  close?(): void
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

export interface ChatTurnTrace {
  input: string
  resolvedQuery: string
  sourceIds: string[]
  answer: string
  retrievalMethod: string
}

const HELP_TEXT = [
  'assistant> Commands:',
  'assistant>   /help  Show chat commands',
  'assistant>   /exit  Exit chat mode',
].join('\n')

const CHAT_MAX_OUTPUT_TOKENS = 4096

export function printChatHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('chat', mode)}`,
    '',
    'Usage:',
    `  ${cmd('chat', mode)}`,
    '',
    'Interactive commands:',
    '  /help  Show chat commands',
    '  /exit  Exit chat mode',
    '',
    'Examples:',
    `  ${cmd('chat', mode)}`,
  ].join('\n')
}

const CHAT_SYSTEM_PROMPT = loadPrompt('chat-system.md')

export async function runChatSession(
  deps: ChatSessionDeps,
  io: ChatIO = createTerminalChatIO()
): Promise<void> {
  const retrievalLimit = deps.retrievalLimit ?? 5
  const maxHistoryTurns = deps.maxHistoryTurns ?? 8
  let conversationState = createInitialConversationState()
  // Accumulated multi-turn message history — grows each turn like Claude Code does.
  // The LLM sees native assistant/user pairs rather than embedded-text history.
  const messages: Message[] = []

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
        const resolvedTurn = deps.conversationalRetrieval
          ? resolveConversationalChatTurn(input, conversationState)
          : {
              type: 'fresh-query' as const,
              input,
              retrievalQuery: input,
              answerFocus: input,
              topic: input,
              goal: 'answer user question',
            }
        const highRecall = requiresHighRecallQuestion(resolvedTurn.retrievalQuery)
        const expandedQuery = deps.graphWriter
          ? await expandQueryWithGraph(resolvedTurn.retrievalQuery, deps.graphWriter)
          : resolvedTurn.retrievalQuery
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
          const recoveryQuery = buildRecoveryQuery(resolvedTurn.retrievalQuery)
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

            retrieval = mergeReadResults(
              retrieval,
              normalizeReadResult(recoveryResult),
              'chat-recovery-retry'
            )
          }
        }

        const retrievalWithFallback = await augmentReadDocumentsWithWorkspaceFallback(
          resolvedTurn.retrievalQuery,
          retrieval,
          deps.workspaceDir ?? process.cwd()
        )
        let retrievalForOutput = retrievalWithFallback

        // Build the per-turn user content: evidence + question.
        // History is carried natively via the messages array — no embedding needed.
        const userContent = buildChatTurnContent({
          question: input,
          resolvedQuestion:
            resolvedTurn.retrievalQuery !== input ? resolvedTurn.retrievalQuery : undefined,
          retrieval: retrievalForOutput,
          conversationState,
        })

        const turnMessages: Message[] = [...messages, { role: 'user', content: userContent }]

        const completion = await deps.llmProvider.call({
          messages: trimMessageHistory(turnMessages, maxHistoryTurns),
          systemPrompt: CHAT_SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
        })

        let answer = completion.text.trim()

        // If the first pass looks weak, try again with a deeper retrieval pass and
        // re-prompt the LLM — do NOT override with deterministic line extracts.
        if (looksLikeInsufficientEvidenceAnswer(answer)) {
          const deepResult = await deps.toolExecutor.execute({
            id: `chat-read-deep-${Date.now()}`,
            name: 'read_documents',
            input: {
              query: resolvedTurn.retrievalQuery,
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
            'chat-deep-discovery-promotion'
          )

          const deepContent = buildChatTurnContent({
            question: input,
            resolvedQuestion:
              resolvedTurn.retrievalQuery !== input ? resolvedTurn.retrievalQuery : undefined,
            retrieval: retrievalForOutput,
            conversationState,
          })
          const deepMessages: Message[] = [...messages, { role: 'user', content: deepContent }]
          const deepCompletion = await deps.llmProvider.call({
            messages: trimMessageHistory(deepMessages, maxHistoryTurns),
            systemPrompt: CHAT_SYSTEM_PROMPT,
            temperature: 0.15,
            maxTokens: CHAT_MAX_OUTPUT_TOKENS,
          })
          const deepAnswer = deepCompletion.text.trim()
          if (deepAnswer) answer = deepAnswer
        }

        if (!answer) {
          answer =
            'I don\'t have enough information to answer that. Try: kb query "<your question>"'
        }

        // Append both sides to the message history so the next turn sees the full context.
        messages.push({ role: 'user', content: userContent })
        messages.push({ role: 'assistant', content: answer })

        io.write(`assistant> ${answer}`)
        io.write(`retrieval> ${formatRetrievalMode(retrievalForOutput.retrieval)}`)
        const checkpointTrace = formatCheckpointTrace(retrievalForOutput.retrieval)
        if (checkpointTrace) {
          io.write(`checkpoints> ${checkpointTrace}`)
        }
        const sourceIds = formatReadDocumentSourceIds(retrievalForOutput.results)
        io.write(`sources> ${sourceIds.join(', ') || 'none'}`)
        deps.onTurnComplete?.({
          input,
          resolvedQuery: resolvedTurn.retrievalQuery,
          sourceIds,
          answer,
          retrievalMethod: formatRetrievalMode(retrievalForOutput.retrieval),
        })

        conversationState = updateConversationState(
          conversationState,
          resolvedTurn,
          {
            answer,
            retrievedDocIds: sourceIds,
          },
          maxHistoryTurns
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        io.error(`error> Chat turn failed: ${message}`)
      }
    }
  } finally {
    io.close?.()
  }
}

function trimMessageHistory(messages: Message[], maxTurns: number): Message[] {
  // Each turn = 1 user + 1 assistant message. Keep at most maxTurns pairs.
  const maxMessages = maxTurns * 2
  if (messages.length <= maxMessages) return messages
  return messages.slice(messages.length - maxMessages)
}

export function buildChatTurnContent(input: {
  question: string
  retrieval: ReadDocumentsResult
  resolvedQuestion?: string
  conversationState?: ChatConversationState
}): string {
  const evidence = buildEvidence(input.retrieval.results)

  const contextLines: string[] = []
  if (input.conversationState?.activeTopic) {
    contextLines.push(`Active topic: ${input.conversationState.activeTopic}`)
  }
  if (input.conversationState?.pendingFollowUp) {
    contextLines.push(`Pending follow-up: ${input.conversationState.pendingFollowUp.query}`)
  }

  return [
    ...(contextLines.length > 0 ? [...contextLines, ''] : []),
    `Retrieved evidence:\n${evidence}`,
    '',
    `User question: ${input.question}`,
    input.resolvedQuestion ? `(retrieval query used: ${input.resolvedQuestion})` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function looksLikeInsufficientEvidenceAnswer(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('evidence provided does not contain') ||
    normalized.includes('retrieved documents do not provide specific information') ||
    normalized.includes('retrieved document does not provide information') ||
    normalized.includes('retrieved document does not provide specific information') ||
    normalized.includes('retrieved evidence does not contain information') ||
    normalized.includes('retrieved evidence does not contain specific information') ||
    normalized.includes('does not provide specific information') ||
    normalized.includes('do not provide specific information') ||
    normalized.includes('does not provide information') ||
    normalized.includes('do not provide information') ||
    normalized.includes('does not contain specific information') ||
    normalized.includes('do not contain specific information') ||
    normalized.includes('does not contain information') ||
    normalized.includes('do not contain information') ||
    normalized.includes('do not contain specific details') ||
    normalized.includes('does not provide specific details') ||
    normalized.includes('do not provide specific details') ||
    normalized.includes('do not contain any information about') ||
    normalized.includes('does not contain any information about') ||
    normalized.includes('cannot provide an answer based on the available evidence') ||
    normalized.includes('evidence is insufficient') ||
    normalized.includes('do not have enough evidence') ||
    normalized.includes('need additional information') ||
    normalized.includes('would need additional information') ||
    normalized.includes('further specific queries')
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
  detailSuffix: string
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
      detail: appendRetrievalDetail(
        secondary.retrieval?.detail ?? primary.retrieval?.detail,
        detailSuffix
      ),
      checkpoints,
    },
  }
}

function getFinalCheckpoint(retrieval: ReadDocumentsResult): ReadDocumentsCheckpoint | undefined {
  const checkpoints = retrieval.retrieval?.checkpoints
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return undefined
  return checkpoints[checkpoints.length - 1]
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
  const isTTY = process.stdin.isTTY === true
  const rl = createInterface({
    input: process.stdin,
    output: isTTY ? process.stdout : undefined,
    terminal: isTTY,
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
