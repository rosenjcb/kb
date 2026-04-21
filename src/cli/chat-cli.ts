import { createInterface } from 'node:readline/promises'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import type { DuckGraphWriter } from '../tools/duck-graph-writer'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { formatGraphRelationBlockFromQuestion } from '../tools/graph-relation-context'
import { createPrinter } from '../ui/printer'
import {
  type ChatConversationState,
  createInitialConversationState,
  resolveConversationalChatTurn,
  updateConversationState,
} from './chat-conversation'
import { type CmdMode, cmd } from './cmd-ref'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import { isReadDocumentsResult, printReadDocumentsOrchestrationFooter } from './intent-cli.js'
import { formatReadDocumentSourceIds } from './retrieval-fallback'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  mode?: CmdMode
  graphWriter?: DuckGraphWriter
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
  conversationalRetrieval?: boolean
  /** When true, human orchestration matches `kb query --verbose` (summary, status, confidence rows). */
  verbose?: boolean
  /** When true, human footer uses one detailed `source>` line per hit (same as `kb query --debug`). */
  debug?: boolean
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
    graphEvidence?: string[]
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

export interface ChatTurnTrace {
  input: string
  resolvedQuery: string
  sourceIds: string[]
  answer: string
  retrievalMethod: string
}

const CHAT_MAX_OUTPUT_TOKENS = 4096

export function printChatHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('chat', mode)}`,
    '',
    'Usage:',
    `  ${cmd('chat', mode)} [--verbose] [--debug] [--base <name>]`,
    '',
    'Flags:',
    '  --verbose   After each answer, also print summary / status / confidence orchestration rows (same as kb query --verbose). Must be passed before the session starts (CLI or TUI shell: chat --verbose).',
    '  --debug     After each answer, print one full provenance `source>` line per retrieved document (ids, paths, snippets). Combine with --verbose if you want both. TUI: chat --debug before the session starts.',
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
  const printer = createPrinter(
    {
      log: line => io.write(line),
      write: line => io.write(line),
      error: line => io.error(line),
    },
    deps.mode ?? 'cli'
  )
  const retrievalLimit = deps.retrievalLimit ?? 5
  const maxHistoryTurns = deps.maxHistoryTurns ?? 8
  let conversationState = createInitialConversationState()
  // Accumulated multi-turn message history — grows each turn like Claude Code does.
  // The LLM sees native assistant/user pairs rather than embedded-text history.
  const messages: Message[] = []

  printer.chatAssistant('Chat mode started. Type /help for commands.')

  if (deps.graphWriter) {
    try {
      await deps.graphWriter.open()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io.error(`[kb-graph] chat graph unavailable: ${message}`)
    }
  }

  try {
    while (true) {
      const rawInput = await io.read('you> ')
      if (rawInput === null) {
        printer.chatAssistant('Exiting chat.')
        break
      }

      const input = rawInput.trim()
      if (!input) continue

      if (input === '/help') {
        printer.chatAssistant('Commands:')
        printer.chatAssistant('  /help  Show chat commands')
        printer.chatAssistant('  /exit  Exit chat mode')
        continue
      }

      if (input === '/exit') {
        printer.chatAssistant('Exiting chat.')
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
        const expandedQuery = deps.graphWriter
          ? await expandQueryWithGraph(resolvedTurn.retrievalQuery, deps.graphWriter)
          : resolvedTurn.retrievalQuery

        let graphRelationBlock: string | undefined
        if (deps.graphWriter) {
          try {
            const block = await formatGraphRelationBlockFromQuestion(deps.graphWriter, input)
            if (block) graphRelationBlock = block
          } catch {
            // Optional relational graph context only.
          }
        }
        const intentResult = await executeChatQueryTruthRetrieval({
          toolExecutor: deps.toolExecutor,
          expandedQuery,
          retrievalLimit,
          workspaceDir: deps.workspaceDir ?? process.cwd(),
        })

        if (!isReadDocumentsResult(intentResult)) {
          const detail =
            intentResult.explanation ??
            intentResult.errorCode ??
            intentResult.status ??
            'retrieval failed'
          io.error(`error> ${detail}`)
          continue
        }

        const retrievalForOutput = normalizeReadResult(intentResult.data)

        const userContent = buildChatTurnContent({
          question: input,
          resolvedQuestion:
            resolvedTurn.retrievalQuery !== input ? resolvedTurn.retrievalQuery : undefined,
          retrieval: retrievalForOutput,
          conversationState,
          graphRelationBlock,
        })

        const turnMessages: Message[] = [...messages, { role: 'user', content: userContent }]

        printer.startSpinner('thinking...')
        const completion = await deps.llmProvider
          .call({
            messages: trimMessageHistory(turnMessages, maxHistoryTurns),
            systemPrompt: CHAT_SYSTEM_PROMPT,
            temperature: 0.15,
            maxTokens: CHAT_MAX_OUTPUT_TOKENS,
          })
          .finally(() => {
            printer.stopSpinner()
          })

        const answer =
          completion.text.trim() ||
          'I don\'t have enough information to answer that. Try: kb query "<your question>"'

        // Append both sides to the message history so the next turn sees the full context.
        messages.push({ role: 'user', content: userContent })
        messages.push({ role: 'assistant', content: answer })

        printer.chatAssistant(answer)
        printer.separator()
        printReadDocumentsOrchestrationFooter(printer, intentResult, {
          verbose: deps.verbose,
          debug: deps.debug,
        })
        const sourceIds = formatReadDocumentSourceIds(retrievalForOutput.results)
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
    if (deps.graphWriter) {
      await deps.graphWriter.close().catch(() => {})
    }
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
  graphRelationBlock?: string
}): string {
  const evidence = buildEvidence(input.retrieval.results)

  const contextLines: string[] = []
  if (input.conversationState?.activeTopic) {
    contextLines.push(`Active topic: ${input.conversationState.activeTopic}`)
  }
  if (input.conversationState?.pendingFollowUp) {
    contextLines.push(`Pending follow-up: ${input.conversationState.pendingFollowUp.query}`)
  }

  const graphSection = input.graphRelationBlock?.trim()
    ? [
        'Structured graph path (shortest directed path when the user question is relational; verify against evidence):',
        input.graphRelationBlock.trim(),
        '',
      ].join('\n')
    : ''

  return [
    ...(contextLines.length > 0 ? [...contextLines, ''] : []),
    graphSection,
    `Retrieved evidence:\n${evidence}`,
    '',
    `User question: ${input.question}`,
    input.resolvedQuestion ? `(retrieval query used: ${input.resolvedQuestion})` : '',
  ]
    .filter(Boolean)
    .join('\n')
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

function formatRetrievalMode(retrieval: ReadDocumentsResult['retrieval']): string {
  const method = retrieval?.method ?? 'unknown'
  const detail = retrieval?.detail ? ` (${retrieval.detail})` : ''
  return `${method}${detail}`
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

  const graphHints = new Set<string>()
  for (const result of results.slice(0, 4)) {
    for (const line of result.graphEvidence ?? []) {
      if (line.trim()) graphHints.add(line.trim())
    }
  }
  if (graphHints.size > 0) {
    sections.push(
      `Graph linkage hints (typed edges; must agree with document text above):\n${[...graphHints].map(h => `- ${h}`).join('\n')}`
    )
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
