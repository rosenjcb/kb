import { createInterface } from 'node:readline/promises'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import { resolveEffectiveBaseDir } from './base-selection'
import { runDocsGenerateChatFlow } from './chat-docs-generate-flow'
import type { KbConfig } from './kb-config'
import { readKbConfig } from './kb-config'
import type { DuckGraphWriter } from '../tools/duck-graph-writer'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { formatGraphRelationBlockFromQuestion } from '../tools/graph-relation-context'
import { createPrinter, type Printer } from '../ui/printer'
import {
  type ChatConversationState,
  createInitialConversationState,
  resolveConversationalChatTurn,
  updateConversationState,
} from './chat-conversation'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import { type CmdMode, cmd } from './cmd-ref'
import { isReadDocumentsResult, printReadDocumentsOrchestrationFooter } from './intent-cli.js'
import { formatReadDocumentSourceIds } from './retrieval-fallback'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  mode?: CmdMode
  graphWriter?: DuckGraphWriter
  /** KB storage directory (`.kb` root). Resolved from cwd when omitted. */
  kbStorageDir?: string
  /** When omitted, `readKbConfig()` is used on first `/docs generate`. */
  kbConfig?: KbConfig
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
  conversationalRetrieval?: boolean
  /** When true, human orchestration matches `kb query --verbose` (summary, status, confidence rows). */
  verbose?: boolean
  /** When true, human footer uses one detailed `source>` line per hit (same as `kb query --debug`). */
  debug?: boolean
  onTurnComplete?: (turn: ChatTurnTrace) => void
  /** Progress heartbeat cadence for long-running turn stages. Default: 8000ms. */
  progressHeartbeatMs?: number
  /** Emit a "still working" notice after this delay. Default: 12000ms. */
  progressNoticeMs?: number
}

export interface ChatIO {
  read(prompt: string): Promise<string | null>
  write(line: string): void
  error(line: string): void
  close?(): void
}

export interface ReadDocumentsResult {
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
    clarificationQuestion?: string
    suggestRetrievalDeepen?: boolean
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
    '  /docs generate "<prompt>" …  Guided doc draft (questionnaire + review)',
    '  /exit  Exit chat mode',
    '',
    'Environment:',
    '  KB_CHAT_RETRIEVAL_MIN_CONFIDENCE  Last retrieval checkpoint must be ≥ this (0–1, default 0.45) or chat answers are skipped with an insufficient-evidence message.',
    '',
    'Examples:',
    `  ${cmd('chat', mode)}`,
  ].join('\n')
}

const CHAT_SYSTEM_PROMPT = loadPrompt('chat-system.md')

const DOC_SESSION_TRANSCRIPT_MAX_CHARS = 12000

/** Shown when retrieval is empty or last checkpoint confidence is below threshold. */
export const CHAT_WEAK_RETRIEVAL_REFUSAL =
  'I don\'t have enough information in the retrieved KB evidence to answer that confidently. Try rephrasing, run `kb query "<topic>"`, or add facts with `kb submit`.'

function chatRetrievalMinConfidence(): number {
  const raw = process.env.KB_CHAT_RETRIEVAL_MIN_CONFIDENCE
  if (!raw) return 0.45
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.45
  return n
}

export function lastRetrievalCheckpointConfidence(snapshot: ReadDocumentsResult): number | undefined {
  const cps = snapshot.retrieval?.checkpoints
  if (!Array.isArray(cps) || cps.length === 0) return undefined
  const last = cps[cps.length - 1]
  const c = last?.confidence
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined
}

export function shouldRefuseChatTurnOnRetrieval(snapshot: ReadDocumentsResult): boolean {
  const n = snapshot.results?.length ?? 0
  if (n === 0) return true
  const conf = lastRetrievalCheckpointConfidence(snapshot)
  if (conf === undefined) return false
  return conf < chatRetrievalMinConfidence()
}

/** Serialize prior chat for `/docs generate` session prompts (tail-preserved, bounded). */
export function formatChatTranscriptForDocSession(
  messages: Message[],
  maxChars: number = DOC_SESSION_TRANSCRIPT_MAX_CHARS
): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const label = m.role === 'user' ? 'User' : 'Assistant'
    parts.push(`${label}:\n${m.content}`)
  }
  let body = parts.join('\n\n').trim()
  if (!body) return ''
  if (body.length > maxChars) {
    body = `…(earlier chat truncated)\n\n${body.slice(-(maxChars - 40))}`
  }
  return body
}

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
  const progressHeartbeatMs = Math.max(1500, deps.progressHeartbeatMs ?? 8000)
  const progressNoticeMs = Math.max(3000, deps.progressNoticeMs ?? 12000)
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

      const docsGen = input.match(/^\/docs\s+generate(?:\s+(.*))?$/i)
      if (docsGen) {
        const slashRest = docsGen[1]?.trim() ?? ''
        const baseDir =
          deps.kbStorageDir ??
          (await resolveEffectiveBaseDir(deps.workspaceDir ?? process.cwd())).baseDir
        const chatConfig = deps.kbConfig ?? (await readKbConfig())
        await runDocsGenerateChatFlow({
          read: prompt => io.read(prompt),
          writeError: line => io.error(line),
          printer,
          llm: deps.llmProvider,
          kbStorageDir: baseDir,
          config: chatConfig,
          slashRest,
          chatTranscript: formatChatTranscriptForDocSession(messages),
        })
        printer.separator()
        continue
      }

      if (input === '/help') {
        printer.chatAssistant('Commands:')
        printer.chatAssistant('  /help  Show chat commands')
        printer.chatAssistant('  /docs generate "<prompt>" …  Guided doc draft')
        printer.chatAssistant('  /exit  Exit chat mode')
        continue
      }

      if (input === '/exit') {
        printer.chatAssistant('Exiting chat.')
        break
      }

      try {
        const turnStartedAt = Date.now()
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
        const initialRetrieval = await withStageProgress(
          printer,
          'retrieval',
          () =>
            executeChatQueryTruthRetrieval({
              toolExecutor: deps.toolExecutor,
              expandedQuery,
              retrievalLimit,
              workspaceDir: deps.workspaceDir ?? process.cwd(),
            }),
          { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
        )
        let retrievalMs = initialRetrieval.durationMs
        let intentResult = initialRetrieval.result

        for (let deepenPass = 0; deepenPass < 2; deepenPass += 1) {
          if (!isReadDocumentsResult(intentResult)) break
          const snapshot = normalizeReadResult(intentResult.data)
          if (!snapshot.retrieval?.suggestRetrievalDeepen) break
          const pass: 1 | 2 = deepenPass === 0 ? 1 : 2
          const deepenedQuery = `${resolvedTurn.retrievalQuery}\n${buildChatAutoDeepenLine(
            resolvedTurn.retrievalQuery,
            pass
          )}`
          const deepened = await withStageProgress(
            printer,
            'retrieval-deepen',
            () =>
              executeChatQueryTruthRetrieval({
                toolExecutor: deps.toolExecutor,
                expandedQuery: deepenedQuery,
                retrievalLimit,
                workspaceDir: deps.workspaceDir ?? process.cwd(),
              }),
            { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
          )
          retrievalMs += deepened.durationMs
          intentResult = deepened.result
        }

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

        let answer: string
        let answerMs: number
        if (shouldRefuseChatTurnOnRetrieval(retrievalForOutput)) {
          const conf = lastRetrievalCheckpointConfidence(retrievalForOutput)
          printer.chatMeta(
            'retrieval',
            `refused: weak-evidence results=${retrievalForOutput.results?.length ?? 0} lastCheckpoint=${conf?.toFixed(3) ?? 'n/a'} min=${chatRetrievalMinConfidence().toFixed(3)}`
          )
          answer = CHAT_WEAK_RETRIEVAL_REFUSAL
          answerMs = 0
        } else {
          const answerRun = await withStageProgress(
            printer,
            'answer',
            () =>
              deps.llmProvider.call({
                messages: trimMessageHistory(turnMessages, maxHistoryTurns),
                systemPrompt: CHAT_SYSTEM_PROMPT,
                temperature: 0.15,
                maxTokens: CHAT_MAX_OUTPUT_TOKENS,
              }),
            { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
          )
          const completion = answerRun.result
          answerMs = answerRun.durationMs

          answer =
            completion.text.trim() ||
            'I don\'t have enough information to answer that. Try: kb query "<your question>"'
        }

        // Append both sides to the message history so the next turn sees the full context.
        messages.push({ role: 'user', content: userContent })
        messages.push({ role: 'assistant', content: answer })

        printer.chatAssistant(answer)
        printer.separator()
        printReadDocumentsOrchestrationFooter(printer, intentResult, {
          verbose: deps.verbose,
          debug: deps.debug,
        })
        printer.chatMeta(
          'timing',
          `retrieval=${retrievalMs}ms answer=${answerMs}ms total=${Date.now() - turnStartedAt}ms`
        )
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

async function withStageProgress<T>(
  printer: Printer,
  stage: string,
  run: () => Promise<T>,
  options: { heartbeatMs: number; noticeMs: number }
): Promise<{ result: T; durationMs: number }> {
  const started = Date.now()
  printer.chatMeta('stage', `${stage}:start`)
  let noticeShown = false
  const timer = setInterval(() => {
    const elapsed = Date.now() - started
    if (!noticeShown && elapsed >= options.noticeMs) {
      printer.chatMeta('stage', `${stage}:still-working ${Math.round(elapsed / 1000)}s`)
      noticeShown = true
      return
    }
    if (noticeShown) {
      printer.chatMeta('stage', `${stage}:progress ${Math.round(elapsed / 1000)}s`)
    }
  }, options.heartbeatMs)
  try {
    const result = await run()
    const durationMs = Date.now() - started
    printer.chatMeta('stage', `${stage}:done ${durationMs}ms`)
    return { result, durationMs }
  } finally {
    clearInterval(timer)
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

function chatDeepenFocusTokens(retrievalQuery: string): string {
  const cleaned = retrievalQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
  return [...new Set(cleaned)].slice(0, 8).join(', ') || 'full question scope'
}

/** Synthetic clarification (no stdin)—mirrors prior interactive clarify passes. */
function buildChatAutoDeepenLine(retrievalQuery: string, pass: 1 | 2): string {
  const focus = chatDeepenFocusTokens(retrievalQuery)
  if (pass === 1) {
    return `Clarification: Automated deepen—cover every substantive angle (${focus}); prioritize exact CLI behavior, init/submit/query flows, architecture, and KB mechanics over short UI-only summaries.`
  }
  return `Clarification: Automated widen—pull adjacent facts on hybrid search, config, skills, evaluation harness, and repo workflow as they relate to: ${focus}.`
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
