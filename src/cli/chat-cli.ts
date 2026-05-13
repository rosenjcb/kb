import { createInterface } from 'node:readline/promises'
import dayjs from 'dayjs'
import { ReportWriter, defaultLogsDir, estimateCost } from '../core/telemetry'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message, ToolDefinition, ToolResultBlock } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import { CodeGraphStore } from '../tools/code-graph-store'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { formatGraphRelationBlockFromQuestion } from '../tools/graph-relation-context'
import { KbGraphWriter } from '../tools/kb-graph-writer'
import { type Printer, createPrinter } from '../ui/printer'
import { resolveEffectiveBaseDir } from './base-selection'
import {
  type ChatConversationState,
  type SessionFact,
  createInitialConversationState,
  resolveConversationalChatTurn,
  updateConversationState,
} from './chat-conversation'
import { runDocsGenerateChatFlow } from './chat-docs-generate-flow'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import { type CmdMode, cmd } from './cmd-ref'
import { parseInitCommand, parseScanCommand, runKbInit } from './init-cli.js'
import { isReadFactsResult, printReadDocumentsOrchestrationFooter } from './intent-cli.js'
import type { KbConfig } from './kb-config'
import { readKbConfig, resolveFactRetrievalMethod } from './kb-config'
import { formatReadDocumentSourceIds } from './retrieval-fallback'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  mode?: CmdMode
  graphWriter?: KbGraphWriter
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
  /** Called once at session start with the session ID so callers can tag related log entries. */
  onSessionStart?: (sessionId: string) => void
  /** Progress heartbeat cadence for long-running turn stages. Default: 8000ms. */
  progressHeartbeatMs?: number
  /** Emit a "still working" notice after this delay. Default: 12000ms. */
  progressNoticeMs?: number
  /** Called after /init or /scan completes so the caller can refresh base metadata. */
  onBaseChanged?: () => void
}

export interface ChatIO {
  read(prompt: string): Promise<string | null>
  write(line: string): void
  error(line: string): void
  setProgressLine?(line: string | null): void
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

export interface ChatTurnStats {
  turn: number
  startedAt: string
  userMessage: string
  inputTokens: number
  outputTokens: number
  factsRetrieved: number
  retrievalMs: number
  answerMs: number
  totalMs: number
}

export interface ChatSessionStats {
  sessionId: string
  startedAt: string
  provider: string
  model: string
  turns: ChatTurnStats[]
}

function createSessionStats(provider: string, model: string): ChatSessionStats {
  return {
    sessionId: `chat-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: dayjs().toISOString(),
    provider,
    model,
    turns: [],
  }
}

async function flushSessionLog(stats: ChatSessionStats): Promise<void> {
  if (stats.turns.length === 0) return
  const writer = new ReportWriter(defaultLogsDir())
  const totalInputTokens = stats.turns.reduce((s, t) => s + t.inputTokens, 0)
  const totalOutputTokens = stats.turns.reduce((s, t) => s + t.outputTokens, 0)
  const totalDurationMs = stats.turns.reduce((s, t) => s + t.totalMs, 0)
  const totalCostUsd = estimateCost(
    stats.provider,
    stats.model,
    totalInputTokens,
    totalOutputTokens
  )
  await writer.append({
    runId: stats.sessionId,
    sessionId: stats.sessionId,
    command: 'chat',
    startedAt: stats.startedAt,
    finishedAt: dayjs().toISOString(),
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: totalCostUsd,
    stages: stats.turns.map(t => ({
      stage: `turn-${t.turn}`,
      startedAt: t.startedAt,
      durationMs: t.totalMs,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      estimatedCostUsd: estimateCost(stats.provider, stats.model, t.inputTokens, t.outputTokens),
      provider: stats.provider,
      model: stats.model,
    })),
    status: 'success',
  })
}

function formatSessionStats(stats: ChatSessionStats, printer: Printer): void {
  const { turns } = stats
  if (turns.length === 0) {
    printer.chatAssistant('No turns this session yet.')
    return
  }

  const totalIn = turns.reduce((s, t) => s + t.inputTokens, 0)
  const totalOut = turns.reduce((s, t) => s + t.outputTokens, 0)
  const totalFacts = turns.reduce((s, t) => s + t.factsRetrieved, 0)
  const totalMs = turns.reduce((s, t) => s + t.totalMs, 0)
  const totalCostUsd = estimateCost(stats.provider, stats.model, totalIn, totalOut)
  const costStr = totalCostUsd > 0 ? `$${totalCostUsd.toFixed(5)}` : '$0.00000'

  const col = (s: string, w: number) => s.slice(0, w).padEnd(w)
  const rCol = (s: string, w: number) => s.slice(0, w).padStart(w)

  const header = [
    col('#', 4),
    col('time', 8),
    rCol('in tok', 8),
    rCol('out tok', 8),
    rCol('facts', 6),
    rCol('retr ms', 8),
    rCol('ans ms', 8),
    rCol('total ms', 9),
    '  message',
  ].join(' ')
  const divider = '─'.repeat(header.length)

  const lines = [
    `session> id: ${stats.sessionId}`,
    `session> started: ${dayjs(stats.startedAt).format('YYYY-MM-DD HH:mm:ss')}`,
    `session> model: ${stats.provider}/${stats.model}`,
    `session> turns: ${turns.length}`,
    '',
    header,
    divider,
    ...turns.map(t =>
      [
        col(String(t.turn), 4),
        col(dayjs(t.startedAt).format('HH:mm:ss'), 8),
        rCol(String(t.inputTokens), 8),
        rCol(String(t.outputTokens), 8),
        rCol(String(t.factsRetrieved), 6),
        rCol(String(t.retrievalMs), 8),
        rCol(String(t.answerMs), 8),
        rCol(String(t.totalMs), 9),
        `  ${t.userMessage.slice(0, 48)}${t.userMessage.length > 48 ? '…' : ''}`,
      ].join(' ')
    ),
    divider,
    [
      col('Σ', 4),
      col('', 8),
      rCol(String(totalIn), 8),
      rCol(String(totalOut), 8),
      rCol(String(totalFacts), 6),
      rCol('', 8),
      rCol('', 8),
      rCol(String(totalMs), 9),
      `  est. cost: ${costStr}`,
    ].join(' '),
  ]

  printer.chatAssistant(lines.join('\n'))
}

const CHAT_MAX_OUTPUT_TOKENS = 4096

const CHAT_QUERY_TOOL: ToolDefinition = {
  name: 'query',
  description:
    'Search the knowledge base for additional facts. Call this proactively — especially for code questions — before concluding you lack information. ' +
    'For code-related questions use specific technical identifiers: function names, class names, interface names, file paths, or method signatures seen in prior facts. ' +
    'Call multiple times with different angles (e.g. first "ToolRegistry register", then "createKBToolsRegistry handler", then "tool registration pattern") to build a complete picture.',
  schema: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description:
          'Search query. For code topics, prefer specific identifiers (function/class/interface names) over natural-language descriptions.',
      },
    },
    required: ['q'],
    additionalProperties: false,
  },
}

const MAX_QUERY_TOOL_ROUNDS = 5

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
    '  /help     Show chat commands',
    '  /session  Show session stats (turns, tokens, facts, timing)',
    '  /docs generate "<prompt>" …  Guided doc draft (questionnaire + review)',
    '  /clear    Clear session (fact pool + conversation history)',
    '  /exit     Exit chat mode',
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

export function lastRetrievalCheckpointConfidence(
  snapshot: ReadDocumentsResult
): number | undefined {
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
  let sessionStats = createSessionStats(deps.llmProvider.name, deps.llmProvider.model)
  deps.onSessionStart?.(sessionStats.sessionId)

  printer.chatAssistant('Type a question, or /help for commands.')

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
      if (rawInput === null) break

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

      const initMatch = input.match(/^\/init(\s|$)/i)
      const scanMatch = !initMatch && input.match(/^\/scan(\s|$)/i)
      if (initMatch || scanMatch) {
        const isScan = Boolean(scanMatch)
        const prefix = isScan ? 'scan' : 'init'
        const tail = input.slice(prefix.length + 1).trim()
        const extraArgs = tail ? splitShellArgs(tail) : []
        let parsed: ReturnType<typeof parseInitCommand>
        try {
          parsed = isScan ? parseScanCommand(extraArgs) : parseInitCommand(extraArgs)
        } catch (e) {
          io.error(`❌ ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        io.write(`Starting ${prefix}…`)
        try {
          const result = await runKbInit({
            ...parsed,
            questionIO: {
              write: (msg: string) => io.write(msg),
              askQuestion: async (question: string): Promise<string> => {
                io.setProgressLine?.(null)
                const answer = await io.read(question)
                return answer ?? ''
              },
            },
            progressSink: (line: string) => {
              if (io.setProgressLine) {
                io.setProgressLine(line.trimEnd())
                return
              }
              io.write(line)
            },
          })
          io.setProgressLine?.(null)
          const docCount = result.writtenDocIds?.length ?? 0
          io.write(
            `✅ ${isScan ? 'Scan' : 'Init'} complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`
          )
          deps.onBaseChanged?.()
        } catch (err) {
          io.setProgressLine?.(null)
          io.error(
            `${isScan ? 'Scan' : 'Init'} error: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        printer.separator()
        continue
      }

      if (input === '/help') {
        printer.chatAssistant(
          [
            'Commands:',
            '  /query <text>          Search the KB',
            '  /submit <text>         Store a fact',
            '  /invalidate <text>     Remove stale facts',
            '  /init [args]           Build a KB from this repo',
            '  /scan [args]           Refresh the KB',
            '  /base <use|delete> …   Manage KB bases',
            '  /docs <list|view|generate|rename|delete> …',
            '  /facts [args]          List or search KB facts',
            '  /graph [args]          Inspect the knowledge graph',
            '  /config [args]         View or update config',
            '  /publish [args]        Publish KB docs',
            '  /sync                  Install latest published KB',
            '  /logs [args]           Browse run reports',
            '  /skill <cmd>           Manage agent skills',
            '  /session               Show session stats (turns, tokens, facts, timing)',
            '  /clear                 Clear session (fact pool + conversation history)',
            '  /exit                  Quit kb',
          ].join('\n')
        )
        continue
      }

      if (input === '/exit') break

      if (input === '/session') {
        formatSessionStats(sessionStats, printer)
        continue
      }

      if (input === '/clear') {
        await flushSessionLog(sessionStats).catch(() => {})
        conversationState = createInitialConversationState()
        messages.length = 0
        sessionStats = createSessionStats(deps.llmProvider.name, deps.llmProvider.model)
        deps.onSessionStart?.(sessionStats.sessionId)
        if (deps.mode !== 'tui') process.stdout.write('\x1Bc')
        printer.chatAssistant('Fresh session. Ask me anything.')
        continue
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
        const isAllFacts = resolveFactRetrievalMethod(deps.kbConfig ?? {}) === 'all_facts'
        let expandedQuery = resolvedTurn.retrievalQuery
        if (deps.graphWriter && !isAllFacts) {
          const codeStore = deps.kbStorageDir
            ? new CodeGraphStore(KbGraphWriter.dbPathForBase(deps.kbStorageDir))
            : undefined
          try {
            expandedQuery = await expandQueryWithGraph(
              resolvedTurn.retrievalQuery,
              deps.graphWriter,
              codeStore
            )
          } finally {
            codeStore?.close()
          }
        }

        let graphRelationBlock: string | undefined
        if (deps.graphWriter && !isAllFacts) {
          try {
            const block = await formatGraphRelationBlockFromQuestion(deps.graphWriter, input)
            if (block) graphRelationBlock = block
          } catch {
            // Relation-path block is best-effort.
          }
        }
        const sessionExcludeIds = conversationState.sessionFactPool.map(f => f.id)
        const initialRetrieval = await withStageProgress(
          printer,
          'retrieval',
          () =>
            executeChatQueryTruthRetrieval({
              toolExecutor: deps.toolExecutor,
              expandedQuery,
              retrievalLimit,
              excludeIds: sessionExcludeIds.length > 0 ? sessionExcludeIds : undefined,
            }),
          { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
        )
        let retrievalMs = initialRetrieval.durationMs
        let intentResult = initialRetrieval.result

        for (let deepenPass = 0; deepenPass < 2; deepenPass += 1) {
          if (!isReadFactsResult(intentResult)) break
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
              }),
            { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
          )
          retrievalMs += deepened.durationMs
          intentResult = deepened.result
        }

        if (!isReadFactsResult(intentResult)) {
          const detail =
            intentResult.explanation ??
            intentResult.errorCode ??
            intentResult.status ??
            'retrieval failed'
          io.error(`error> ${detail}`)
          continue
        }

        const retrievalForOutput = normalizeReadResult(intentResult.data)

        // Collect new facts from this turn's retrieval into the session pool.
        const newFacts: SessionFact[] = (retrievalForOutput.results ?? [])
          .filter(r => r.metadata?.id && r.content)
          .map(r => ({ id: r.metadata?.id ?? '', text: r.content ?? '' }))
        // allNewFacts grows as the agentic query tool retrieves more facts.
        const allNewFacts: SessionFact[] = [...newFacts]

        const userContent = buildChatTurnContent({
          question: input,
          retrieval: retrievalForOutput,
          sessionPool: conversationState.sessionFactPool,
          conversationState,
          graphRelationBlock,
          allFacts: isAllFacts,
        })

        let turnMessages: Message[] = [...messages, { role: 'user', content: userContent }]

        let answer: string
        let answerMs = 0
        if (shouldRefuseChatTurnOnRetrieval(retrievalForOutput)) {
          const conf = lastRetrievalCheckpointConfidence(retrievalForOutput)
          printer.chatMeta(
            'retrieval',
            `refused: weak-evidence results=${retrievalForOutput.results?.length ?? 0} lastCheckpoint=${conf?.toFixed(3) ?? 'n/a'} min=${chatRetrievalMinConfidence().toFixed(3)}`
          )
          answer = CHAT_WEAK_RETRIEVAL_REFUSAL
        } else {
          let totalInputTokens = 0
          let totalOutputTokens = 0
          let completionText = ''

          for (let round = 0; round < MAX_QUERY_TOOL_ROUNDS; round++) {
            const stageName = round === 0 ? 'answer' : `answer-r${round + 1}`
            const roundRun = await withStageProgress(
              printer,
              stageName,
              () =>
                deps.llmProvider.call({
                  messages: turnMessages,
                  tools: [CHAT_QUERY_TOOL],
                  systemPrompt: CHAT_SYSTEM_PROMPT,
                  temperature: 0.15,
                  maxTokens: CHAT_MAX_OUTPUT_TOKENS,
                }),
              { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
            )
            const completion = roundRun.result
            answerMs += roundRun.durationMs
            totalInputTokens += completion.usage.inputTokens
            totalOutputTokens += completion.usage.outputTokens
            completionText = completion.text

            if (completion.stopReason !== 'tool_use' || completion.toolUses.length === 0) {
              break
            }

            // Process query tool calls
            const toolResultBlocks: ToolResultBlock[] = []
            for (const toolUse of completion.toolUses) {
              if (toolUse.name !== 'query') {
                toolResultBlocks.push({
                  type: 'tool_result',
                  toolUseId: toolUse.id,
                  toolName: toolUse.name,
                  result: 'Unknown tool.',
                  isError: true,
                })
                continue
              }
              const q = typeof toolUse.input.q === 'string' ? toolUse.input.q : ''
              if (!q) {
                toolResultBlocks.push({
                  type: 'tool_result',
                  toolUseId: toolUse.id,
                  toolName: toolUse.name,
                  result: 'Empty query.',
                  isError: true,
                })
                continue
              }

              printer.chatMeta('query', q)

              const currentExcludeIds = [...sessionExcludeIds, ...allNewFacts.map(f => f.id)]
              const queryRetrieval = await withStageProgress(
                printer,
                'retrieval-tool',
                () =>
                  executeChatQueryTruthRetrieval({
                    toolExecutor: deps.toolExecutor,
                    expandedQuery: q,
                    retrievalLimit,
                    excludeIds: currentExcludeIds.length > 0 ? currentExcludeIds : undefined,
                  }),
                { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
              )
              retrievalMs += queryRetrieval.durationMs

              let toolResult = 'No additional facts found.'
              if (isReadFactsResult(queryRetrieval.result)) {
                const snapshot = normalizeReadResult(queryRetrieval.result.data)
                const toolFacts: SessionFact[] = (snapshot.results ?? [])
                  .filter(r => r.metadata?.id && r.content)
                  .map(r => ({ id: r.metadata?.id ?? '', text: r.content ?? '' }))
                allNewFacts.push(...toolFacts)
                toolResult = buildToolQueryResult(snapshot)
              }

              toolResultBlocks.push({
                type: 'tool_result',
                toolUseId: toolUse.id,
                toolName: toolUse.name,
                result: toolResult,
              })
            }

            // Append the assistant tool-use turn + results for the next round.
            turnMessages = [
              ...turnMessages,
              {
                role: 'assistant' as const,
                content: completion.text,
                toolUses: completion.toolUses,
              },
              {
                role: 'user' as const,
                content: toolResultBlocks,
              },
            ]
          }

          answer =
            completionText.trim() ||
            'I don\'t have enough information to answer that. Try: kb query "<your question>"'

          sessionStats.turns.push({
            turn: sessionStats.turns.length + 1,
            startedAt: new Date(turnStartedAt).toISOString(),
            userMessage: input,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            factsRetrieved: allNewFacts.length,
            retrievalMs,
            answerMs,
            totalMs: Date.now() - turnStartedAt,
          })
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
            newFacts: allNewFacts,
          },
          maxHistoryTurns
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        io.error(`error> Chat turn failed: ${message}`)
      }
    }
  } finally {
    await flushSessionLog(sessionStats).catch(() => {})
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

export function buildChatTurnContent(input: {
  question: string
  retrieval: ReadDocumentsResult
  conversationState?: ChatConversationState
  graphRelationBlock?: string
  sessionPool?: SessionFact[]
  allFacts?: boolean
}): string {
  const evidence = buildEvidence(input.retrieval.results, input.allFacts)

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

  const priorFactIds = new Set((input.retrieval.results ?? []).map(r => r.metadata?.id))
  const poolFacts = (input.sessionPool ?? []).filter(f => !priorFactIds.has(f.id))
  const poolSection =
    poolFacts.length > 0
      ? `Session fact pool (facts retrieved in earlier turns — still relevant context):\n${poolFacts.map((f, i) => `${i + 1}. [${f.id}] ${f.text.replace(/\r?\n/g, ' ').slice(0, 300)}`).join('\n')}`
      : ''

  return [
    ...(contextLines.length > 0 ? [...contextLines, ''] : []),
    graphSection,
    `Retrieved evidence:\n${evidence}`,
    poolSection,
    '',
    `User question: ${input.question}`,
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

function splitShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  for (const char of input) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false
        args.push(current)
        current = ''
      } else current += char
    } else if (char === '"' || char === "'") {
      if (current) {
        args.push(current)
        current = ''
      }
      inQuote = true
      quoteChar = char
    } else if (char === ' ') {
      if (current) {
        args.push(current)
        current = ''
      }
    } else current += char
  }
  if (current) args.push(current)
  return args
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

function buildEvidence(results: ReadDocumentsResult['results'], allFacts?: boolean): string {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No evidence retrieved from KB documents.'
  }

  const slice = allFacts ? results : results.slice(0, 4)
  const sections: string[] = []

  for (const [index, result] of slice.entries()) {
    const docId = result.metadata?.id ?? `doc-${index + 1}`
    const content = (result.content ?? '').trim()
    const snippet = content.length > 900 ? `${content.slice(0, 900)}...` : content
    sections.push(`Document ${index + 1} (${docId}):\n${snippet || 'No content available.'}`)
  }

  const graphHints = new Set<string>()
  for (const result of slice) {
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

function buildToolQueryResult(snapshot: ReadDocumentsResult): string {
  const results = snapshot.results ?? []
  if (results.length === 0) return 'No additional facts found.'
  return results
    .slice(0, 8)
    .map((r, i) => {
      const id = r.metadata?.id ?? `fact-${i + 1}`
      const text = (r.content ?? '').trim().replace(/\r?\n/g, ' ').slice(0, 500)
      return `${i + 1}. [${id}] ${text}`
    })
    .join('\n')
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
