import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import dayjs from 'dayjs'
import {
  formatRetrievedFactsForLLM,
  formatSessionPoolFactsForLLM,
  formatToolQueryFactsForLLM,
  MAX_FACT_CONTENT_CHARS,
} from '../core/retrieval-context'
import { MAX_FACTS_FOR_LLM } from '../tools/facts-query-research-orchestrator'
import { ReportWriter, RunCollector, defaultLogsDir, estimateCost } from '../core/telemetry'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider, Message, ToolDefinition, ToolResultBlock } from '../core/types'
import { loadPrompt } from '../prompts/loader'
import { DatabaseSync } from 'node:sqlite'
import { expandQueryWithGraph, kbIndexDbPath } from '../tools/graph-query-expansion'
import { type Printer, createPrinter, createReasoningProgressSink } from '../ui/printer'
import { resolveEffectiveBaseDir } from './base-selection'
import type { SessionFact } from './chat-conversation'
import { runDocsGenerateChatFlow } from './chat-docs-generate-flow'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import type { IntentResult } from '../intents/types.js'
import type { SlashInputContext } from '../tui/slash-command-registry.js'
import { type CmdMode, cmd } from './cmd-ref'
import { parseInitCommand, parseScanCommand, runKbInit, isInitCancelledError } from './init-cli.js'
import { initCancelledNotice, scanCancelledNotice } from './cli-prerequisites.js'
import { isReadFactsResult, printReadDocumentsOrchestrationFooter } from './intent-cli.js'
import type { KbConfig } from './kb-config'
import { readKbConfig, resolveFactRetrievalMethod } from './kb-config'
import { formatReadDocumentSourceIds } from './retrieval-fallback'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  mode?: CmdMode
  /** KB storage directory (`.kb` root). Resolved from cwd when omitted. */
  kbStorageDir?: string
  /** When omitted, `readKbConfig()` is used on first `/docs generate`. */
  kbConfig?: KbConfig
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
  /** @deprecated No longer used — routing is LLM-driven. Kept for API compatibility. */
  conversationalRetrieval?: boolean
  /** When true, human orchestration matches `kb query --verbose` (summary, status, confidence rows). */
  verbose?: boolean
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

export interface ChatReadOptions {
  slashContext?: SlashInputContext
  /** Plain-text inline completions (e.g. base names). Shown when input doesn't start with '/'. */
  suggestions?: string[]
}

export interface ChatIO {
  read(prompt: string, opts?: ChatReadOptions): Promise<string | null>
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
  base?: string
  turns: ChatTurnStats[]
}

function createSessionStats(provider: string, model: string, base?: string): ChatSessionStats {
  return {
    sessionId: `chat-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: dayjs().toISOString(),
    provider,
    model,
    base,
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
    ...(stats.base ? { base: stats.base } : {}),
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

const MAX_SYNTHESIS_TURNS = 12

const CHAT_QUERY_KB_TOOL: ToolDefinition = {
  name: 'query_kb',
  description:
    'Search the knowledge base and return relevant facts. Call this for any question about the codebase, ' +
    'architecture, features, APIs, or anything stored in the knowledge base. ' +
    'For greetings, meta questions ("what can you do?"), or answers already available in conversation history, answer directly without calling this tool. ' +
    'Use specific technical identifiers when possible (function names, class names, file paths).',
  schema: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description: 'The question or topic to search for in the knowledge base.',
      },
    },
    required: ['q'],
    additionalProperties: false,
  },
}

export function printChatHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('chat', mode)}`,
    '',
    'Usage:',
    `  ${cmd('chat', mode)} [--verbose] [--base <name>]`,
    '',
    'Flags:',
    '  --verbose   After each answer, also print summary / status / confidence orchestration rows (same as kb query --verbose). Must be passed before the session starts (CLI or TUI shell: chat --verbose).',
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

const CHAT_ROUTER_SYSTEM_PROMPT = loadPrompt('chat-router-system.md')
const CHAT_DECOMPOSE_SYSTEM_PROMPT = loadPrompt('chat-decompose-system.md')

const DOC_SESSION_TRANSCRIPT_MAX_CHARS = 12000

/** Shown when retrieval is empty or last checkpoint confidence is below threshold. */
export const CHAT_WEAK_RETRIEVAL_REFUSAL =
  'I don\'t have enough information in the retrieved KB evidence to answer that confidently. Try rephrasing or run `kb query "<topic>"`.'

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
  if (snapshot.retrieval?.detail === 'all-facts:already-in-context') return false
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

export interface ChatSynthesisResult {
  answer: string
  inputTokens: number
  outputTokens: number
  answerMs: number
  factsRetrieved: number
  lastIntentResult?: IntentResult
}

/**
 * Canonical smart agentic loop for KB question answering.
 * Used by both `kb query` (retrieval provided) and `kb chat` per turn (retrieval undefined).
 */
export async function runChatSynthesis(params: {
  question: string
  /** Pre-fetched retrieval from `kb query`. Omit for the chat path (no initial retrieval). */
  retrieval?: ReadDocumentsResult
  messages: Message[]
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  kbStorageDir?: string
  isAllFacts?: boolean
  graphRelationBlock?: string
  printer: Printer
  retrievalLimit?: number
  progressHeartbeatMs?: number
  progressNoticeMs?: number
}): Promise<ChatSynthesisResult> {
  const heartbeatMs = params.progressHeartbeatMs ?? 8000
  const noticeMs = params.progressNoticeMs ?? 12000
  const retrievalLimit = params.retrievalLimit ?? MAX_FACTS_FOR_LLM

  if (params.retrieval !== undefined && shouldRefuseChatTurnOnRetrieval(params.retrieval)) {
    return {
      answer: CHAT_WEAK_RETRIEVAL_REFUSAL,
      inputTokens: 0,
      outputTokens: 0,
      answerMs: 0,
      factsRetrieved: params.retrieval.results?.length ?? 0,
    }
  }

  // kb query path: inject pre-fetched retrieval as the initial user message
  // chat path: messages already contain the full history including the user question
  let turnMessages: Message[]
  if (params.retrieval !== undefined) {
    const userContent = buildChatTurnContent({
      question: params.question,
      retrieval: params.retrieval,
      allFacts: params.isAllFacts,
      graphRelationBlock: params.graphRelationBlock,
    })
    turnMessages = [...params.messages, { role: 'user', content: userContent }]
  } else {
    turnMessages = [...params.messages]
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let completionText = ''
  const started = Date.now()
  let factsRetrieved = params.retrieval?.results?.length ?? 0
  let lastIntentResult: IntentResult | undefined
  let round = 0

  while (true) {
    const stageName = round === 0 ? 'answer' : `answer-r${round + 1}`
    // Stream the model's reasoning onto the transient progress line so the user sees
    // what the model is working through; it disappears once the answer arrives.
    const onReasoning = createReasoningProgressSink(params.printer)
    const roundRun = await withStageProgress(
      params.printer,
      stageName,
      () =>
        params.llmProvider.call({
          messages: turnMessages,
          tools: [CHAT_QUERY_KB_TOOL],
          systemPrompt: CHAT_ROUTER_SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
          onReasoning,
        }),
      { heartbeatMs, noticeMs }
    )
    round++
    const completion = roundRun.result
    totalInputTokens += completion.usage.inputTokens
    totalOutputTokens += completion.usage.outputTokens
    completionText = completion.text

    if (completion.stopReason !== 'tool_use' || completion.toolUses.length === 0 || round >= MAX_SYNTHESIS_TURNS) {
      break
    }

    const toolResultBlocks = await Promise.all(
      completion.toolUses.map(async (toolUse) => {
        if (toolUse.name !== 'query_kb') {
          return {
            type: 'tool_result' as const,
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            result: 'Unknown tool.',
            isError: true,
          }
        }
        const q = typeof toolUse.input.q === 'string' ? toolUse.input.q : ''
        if (!q) {
          return {
            type: 'tool_result' as const,
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            result: 'Empty query.',
            isError: true,
          }
        }

        params.printer.chatMeta('query', q)

        let expandedQuery = q
        if (params.kbStorageDir && !params.isAllFacts) {
          try {
            const db = new DatabaseSync(kbIndexDbPath(params.kbStorageDir), { readOnly: true })
            try {
              expandedQuery = expandQueryWithGraph(q, db)
            } finally {
              db.close()
            }
          } catch {
            // graph expansion is best-effort
          }
        }

        const retrievalRun = await withStageProgress(
          params.printer,
          'retrieval-tool',
          () =>
            executeChatQueryTruthRetrieval({
              toolExecutor: params.toolExecutor,
              expandedQuery,
              retrievalLimit,
            }),
          { heartbeatMs, noticeMs }
        )

        let toolResult = 'No facts found.'
        if (isReadFactsResult(retrievalRun.result)) {
          lastIntentResult = retrievalRun.result
          const snapshot = normalizeReadResult(retrievalRun.result.data)
          factsRetrieved += snapshot.results?.length ?? 0
          toolResult = buildToolQueryResult(snapshot) || 'No facts found.'
        }

        return {
          type: 'tool_result' as const,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result: toolResult,
        }
      })
    )

    turnMessages = [
      ...turnMessages,
      { role: 'assistant' as const, content: completion.text, toolUses: completion.toolUses },
      { role: 'user' as const, content: toolResultBlocks },
    ]
  }

  return {
    answer:
      completionText.trim() ||
      'I don\'t have enough information to answer that. Try rephrasing.',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    answerMs: Date.now() - started,
    factsRetrieved,
    lastIntentResult,
  }
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
      ...(io.setProgressLine ? { progress: (line: string | null) => io.setProgressLine?.(line) } : {}),
    },
    deps.mode ?? 'cli'
  )
  const retrievalLimit = deps.retrievalLimit ?? MAX_FACTS_FOR_LLM
  const maxHistoryTurns = deps.maxHistoryTurns ?? 8
  const progressHeartbeatMs = Math.max(1500, deps.progressHeartbeatMs ?? 8000)
  const progressNoticeMs = Math.max(3000, deps.progressNoticeMs ?? 12000)
  // Accumulated multi-turn message history — grows each turn.
  const messages: Message[] = []
  const sessionBase = deps.kbStorageDir ? path.basename(deps.kbStorageDir) : undefined
  let sessionStats = createSessionStats(deps.llmProvider.name, deps.llmProvider.model, sessionBase)
  deps.onSessionStart?.(sessionStats.sessionId)

  printer.chatAssistant('Type a question, or /help for commands.')


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
          read: (prompt, opts) => io.read(prompt, opts),
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
        const initScanCollector = new RunCollector(prefix, { sessionId: sessionStats.sessionId })
        const initScanReporter = new ReportWriter(defaultLogsDir())
        try {
          const result = await runKbInit({
            ...parsed,
            collector: initScanCollector,
            questionIO: {
              write: (msg: string) => io.write(msg),
              askQuestion: async (question, opts): Promise<string> => {
                io.setProgressLine?.(null)
                const answer = await io.read(question, { slashContext: opts?.slashContext })
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
          await initScanReporter.append(initScanCollector.finish('success', undefined, result.base))
          const docCount = result.writtenDocIds?.length ?? 0
          io.write(
            `✅ ${isScan ? 'Scan' : 'Init'} complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`
          )
          deps.onBaseChanged?.()
        } catch (err) {
          io.setProgressLine?.(null)
          if (isInitCancelledError(err)) {
            const baseName = deps.kbStorageDir ? path.basename(deps.kbStorageDir) : undefined
            io.write(isScan ? scanCancelledNotice(baseName) : initCancelledNotice(baseName))
            await initScanReporter.append(initScanCollector.finish('success', undefined)).catch(() => {})
          } else {
            const errMsg = err instanceof Error ? err.message : String(err)
            await initScanReporter.append(initScanCollector.finish('error', errMsg)).catch(() => {})
            io.error(`${isScan ? 'Scan' : 'Init'} error: ${errMsg}`)
          }
        }
        printer.separator()
        continue
      }

      if (input === '/help') {
        printer.chatAssistant(
          [
            'Commands:',
            '  /query <text>          Search the KB',
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
        messages.length = 0
        sessionStats = createSessionStats(deps.llmProvider.name, deps.llmProvider.model, sessionBase)
        deps.onSessionStart?.(sessionStats.sessionId)
        if (deps.mode !== 'tui') process.stdout.write('\x1Bc')
        printer.chatAssistant('Fresh session. Ask me anything.')
        continue
      }

      try {
        const turnStartedAt = Date.now()
        const isAllFacts = resolveFactRetrievalMethod(deps.kbConfig ?? {}) === 'all_facts'

        // Trim history before adding the new turn
        while (messages.length >= maxHistoryTurns * 2) {
          messages.splice(0, 2)
        }

        let turnMessages: Message[] = [...messages, { role: 'user', content: input }]
        let answer = ''
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let retrievalMs = 0
        let answerMs = 0
        let factsRetrieved = 0
        let lastIntentResult: IntentResult | undefined

        // Query decomposition pre-step: for synthesis/elaboration queries, retrieve from multiple
        // angles before the LLM-driven tool loop so the model has grounded context upfront.
        if (!input.startsWith('/') && SYNTHESIS_QUERY_RE.test(input)) {
          const subQueries = await decomposeQueryForRetrieval(input, deps.llmProvider)
          if (subQueries.length > 1) {
            const preToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> =
              subQueries.map((q, i) => ({ id: `pre-${i}`, name: 'query_kb', input: { q } }))

            for (const q of subQueries) printer.chatMeta('query', q)

            // Run all sub-query retrievals in parallel (mirrors how Claude Code batches tool calls)
            const preRetrievals = await Promise.all(
              subQueries.map(async (q, i) => {
                let expandedQuery = q
                if (deps.kbStorageDir && !isAllFacts) {
                  try {
                    const db = new DatabaseSync(kbIndexDbPath(deps.kbStorageDir), { readOnly: true })
                    try {
                      expandedQuery = expandQueryWithGraph(q, db)
                    } finally {
                      db.close()
                    }
                  } catch {
                    // graph expansion is best-effort
                  }
                }
                const run = await withStageProgress(
                  printer,
                  'retrieval-pre',
                  () =>
                    executeChatQueryTruthRetrieval({
                      toolExecutor: deps.toolExecutor,
                      expandedQuery,
                      retrievalLimit,
                    }),
                  { heartbeatMs: progressHeartbeatMs, noticeMs: progressNoticeMs }
                )
                return { i, run }
              })
            )

            const preToolResults: ToolResultBlock[] = preRetrievals.map(({ i, run }) => {
              retrievalMs += run.durationMs
              let toolResult = 'No facts found.'
              if (isReadFactsResult(run.result)) {
                lastIntentResult = run.result
                const snapshot = normalizeReadResult(run.result.data)
                factsRetrieved += snapshot.results?.length ?? 0
                toolResult = buildToolQueryResult(snapshot) || 'No facts found.'
              }
              return {
                type: 'tool_result' as const,
                toolUseId: `pre-${i}`,
                toolName: 'query_kb',
                result: toolResult,
              }
            })

            // Inject as synthetic assistant (tool calls) + user (tool results) pair
            turnMessages = [
              ...turnMessages,
              { role: 'assistant' as const, content: '', toolUses: preToolUses },
              { role: 'user' as const, content: preToolResults },
            ]
          }
        }

        const synthesis = await runChatSynthesis({
          question: input,
          retrieval: undefined,
          messages: turnMessages,
          llmProvider: deps.llmProvider,
          toolExecutor: deps.toolExecutor,
          kbStorageDir: deps.kbStorageDir,
          isAllFacts,
          printer,
          retrievalLimit,
          progressHeartbeatMs,
          progressNoticeMs,
        })
        answer = synthesis.answer
        totalInputTokens = synthesis.inputTokens
        totalOutputTokens = synthesis.outputTokens
        answerMs = synthesis.answerMs
        factsRetrieved += synthesis.factsRetrieved
        lastIntentResult = synthesis.lastIntentResult

        messages.push({ role: 'user', content: input })
        messages.push({ role: 'assistant', content: answer })

        printer.chatAssistant(answer)
        printer.separator()
        if (lastIntentResult) {
          printReadDocumentsOrchestrationFooter(printer, lastIntentResult, {
            verbose: deps.verbose,
          })
        }
        printer.chatMeta(
          'timing',
          `retrieval=${retrievalMs}ms answer=${answerMs}ms total=${Date.now() - turnStartedAt}ms`
        )

        const sourceIds = lastIntentResult
          ? formatReadDocumentSourceIds(normalizeReadResult(lastIntentResult.data).results)
          : []
        deps.onTurnComplete?.({
          input,
          resolvedQuery: input,
          sourceIds,
          answer,
          retrievalMethod: lastIntentResult
            ? formatRetrievalMode(normalizeReadResult(lastIntentResult.data).retrieval)
            : 'none',
        })

        sessionStats.turns.push({
          turn: sessionStats.turns.length + 1,
          startedAt: new Date(turnStartedAt).toISOString(),
          userMessage: input,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          factsRetrieved,
          retrievalMs,
          answerMs,
          totalMs: Date.now() - turnStartedAt,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        io.error(`error> Chat turn failed: ${message}`)
      }
    }
  } finally {
    await flushSessionLog(sessionStats).catch(() => {})
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
    // Clear any transient reasoning/progress line now the stage has settled.
    printer.clearProgress()
  }
}

export function buildChatTurnContent(input: {
  question: string
  retrieval: ReadDocumentsResult
  graphRelationBlock?: string
  sessionPool?: SessionFact[]
  allFacts?: boolean
}): string {
  const alreadyInContext = input.retrieval.retrieval?.detail === 'all-facts:already-in-context'
  const evidence = alreadyInContext
    ? 'All KB facts were loaded earlier in this conversation. Use what you already know from prior context to answer.'
    : buildEvidence(input.retrieval.results, input.allFacts)

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
      ? `Session fact pool (facts retrieved in earlier turns — still relevant context):\n${formatSessionPoolFactsForLLM(poolFacts)}`
      : ''

  return [
    graphSection,
    `Retrieved evidence:\n${evidence}`,
    poolSection,
    '',
    `User question: ${input.question}`,
  ]
    .filter(Boolean)
    .join('\n')
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

const SYNTHESIS_QUERY_RE =
  /\b(elaborate|build on|expand on|tell me more|summarize|give me an overview|overview of|dive into|go deeper|how does .+ relate|walk me through)\b/i

async function decomposeQueryForRetrieval(
  input: string,
  llmProvider: LLMProvider
): Promise<string[]> {
  if (input.length < 40 || !SYNTHESIS_QUERY_RE.test(input)) return [input]
  try {
    const response = await llmProvider.call({
      messages: [{ role: 'user', content: input }],
      systemPrompt: CHAT_DECOMPOSE_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 150,
      thinkingBudget: 0,
    })
    const lines = response.text
      .trim()
      .split('\n')
      .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
      .filter(l => l.length > 0)
    return lines.length > 0 ? lines.slice(0, 4) : [input]
  } catch {
    return [input]
  }
}

export function normalizeReadResult(value: unknown): ReadDocumentsResult {
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

function buildEvidence(results: ReadDocumentsResult['results'], _allFacts?: boolean): string {
  return formatRetrievedFactsForLLM(results, { maxContentChars: MAX_FACT_CONTENT_CHARS })
}

function buildToolQueryResult(snapshot: ReadDocumentsResult): string {
  const results = snapshot.results ?? []
  const lines = formatToolQueryFactsForLLM(results)
  if (results.length === 0) return lines
  const detail = snapshot.retrieval?.detail ?? ''
  const isWeakEvidence = detail.includes('weak_evidence_after_exhaustion')
  const isFrontierExhausted = detail.includes('frontier_exhausted')
  if (isWeakEvidence) {
    return `${lines}\n\n[Retrieval confidence was low — the graph frontier was exhausted without strong evidence. Try querying with different or broader terms before answering.]`
  }
  if (isFrontierExhausted) {
    return `${lines}\n\n[Graph frontier exhausted — all reachable nodes from initial query seeds were visited. If the above facts don't fully answer the question, try at least two more queries using specific technical identifiers (function names, file paths, constant names) rather than natural-language descriptions.]`
  }
  return lines
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
    async read(prompt: string, _opts?: ChatReadOptions): Promise<string | null> {
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
