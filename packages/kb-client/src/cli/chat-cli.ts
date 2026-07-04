import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import dayjs from 'dayjs'
import { DEFAULT_FACT_LIMIT } from '@kb/core/tools/facts-query-research-orchestrator.js'
import { ReportWriter, RunCollector, defaultLogsDir, estimateCost } from '@kb/core/core/telemetry.js'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider, Message, ToolResultBlock } from '@kb/core/core/types.js'
import { loadPrompt } from '@kb/core/prompts/loader.js'
import { DatabaseSync } from 'node:sqlite'
import { expandQueryWithGraph, kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import { type Printer, createPrinter } from '@kb/core/ui/printer.js'
import { resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
import { runDocsGenerateChatFlow } from './chat-docs-generate-flow'
import {
  buildToolQueryResult,
  normalizeReadResult,
  runChatSynthesis,
  withStageProgress,
  type ReadDocumentsResult,
} from '@kb/core/query/chat-synthesis.js'
import { executeChatQueryTruthRetrieval } from '@kb/core/query/chat-query-orchestrator.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import type { SlashInputContext } from '../tui/slash-command-registry.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import { parseInitCommand, runKbInit, isInitCancelledError } from '@kb/core/ops/init-cli.js'
import { initCancelledNotice } from '@kb/core/config/cli-prerequisites.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import {
  isReadFactsResult,
  printReadDocumentsOrchestrationFooter,
} from '@kb/core/query/intent-cli.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { readKbConfig, resolveFactRetrievalMethod } from '@kb/core/config/kb-config.js'
import { formatReadDocumentSourceIds } from '@kb/core/query/retrieval-fallback.js'
import { runRemoteChatSession, runRemoteSlashCommand, shouldUseRemoteServer } from './remote-commands.js'

export type { ChatSynthesisResult, ReadDocumentsResult } from '@kb/core/query/chat-synthesis.js'
export {
  buildChatTurnContent,
  buildToolQueryResult,
  CHAT_WEAK_RETRIEVAL_REFUSAL,
  lastRetrievalCheckpointConfidence,
  normalizeReadResult,
  runChatSynthesis,
  shouldRefuseChatTurnOnRetrieval,
} from '@kb/core/query/chat-synthesis.js'

export interface ChatSessionDeps {
  /** Required for local (`KB_LOCAL_MODE`) chat; unused in remote mode (synthesis runs server-side). */
  llmProvider?: LLMProvider
  /** Required for local (`KB_LOCAL_MODE`) chat; unused in remote mode (retrieval runs server-side). */
  toolExecutor?: ToolExecutor
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

const CHAT_DECOMPOSE_SYSTEM_PROMPT = loadPrompt('chat-decompose-system.md')

const DOC_SESSION_TRANSCRIPT_MAX_CHARS = 12000

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
  if (shouldUseRemoteServer()) {
    return runRemoteChatSession(deps, io)
  }
  // Local mode requires the in-process LLM provider + tool executor. Remote mode
  // returned above, so a missing provider here is a real misconfiguration.
  const { llmProvider, toolExecutor } = deps
  if (!llmProvider || !toolExecutor) {
    io.error('Local chat requires an LLM provider and tool executor (set an API key, or run against a kb-server).')
    io.close?.()
    return
  }
  const printer = createPrinter(
    {
      log: line => io.write(line),
      write: line => io.write(line),
      error: line => io.error(line),
      ...(io.setProgressLine ? { progress: (line: string | null) => io.setProgressLine?.(line) } : {}),
    },
    deps.mode ?? 'cli'
  )
  const retrievalLimit = deps.retrievalLimit ?? DEFAULT_FACT_LIMIT
  const maxHistoryTurns = deps.maxHistoryTurns ?? 8
  const progressHeartbeatMs = Math.max(1500, deps.progressHeartbeatMs ?? 8000)
  const progressNoticeMs = Math.max(3000, deps.progressNoticeMs ?? 12000)
  // Accumulated multi-turn message history — grows each turn.
  const messages: Message[] = []
  const sessionBase = deps.kbStorageDir ? path.basename(deps.kbStorageDir) : undefined
  let sessionStats = createSessionStats(llmProvider.name, llmProvider.model, sessionBase)
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
          llm: llmProvider,
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
      if (scanMatch) {
        const tail = input.slice('scan'.length + 1).trim()
        const extraArgs = tail ? splitShellArgs(tail) : []
        if (shouldUseRemoteServer()) {
          const chatConfig = deps.kbConfig ?? (await readKbConfig())
          io.write('Starting scan (remote server)…')
          const { exitCode } = await runRemoteSlashCommand(['scan', ...extraArgs], line => {
            if (io.setProgressLine) io.setProgressLine(line.trimEnd())
            else io.write(line)
          }, chatConfig)
          io.setProgressLine?.(null)
          if (exitCode === 0) deps.onBaseChanged?.()
          printer.separator()
          continue
        }
        const scanCollector = new RunCollector('scan', { sessionId: sessionStats.sessionId })
        const scanReporter = new ReportWriter(defaultLogsDir())
        try {
          io.write('Starting scan…')
          const summary = await runScanCommand(extraArgs, line => {
            if (io.setProgressLine) io.setProgressLine(line.trimEnd())
            else io.write(line)
          })
          io.setProgressLine?.(null)
          io.write(`✅ ${summary}`)
          await scanReporter.append(scanCollector.finish('success', undefined))
          deps.onBaseChanged?.()
        } catch (err) {
          io.setProgressLine?.(null)
          const errMsg = err instanceof Error ? err.message : String(err)
          await scanReporter.append(scanCollector.finish('error', errMsg)).catch(() => {})
          io.error(`Scan error: ${errMsg}`)
        }
        printer.separator()
        continue
      }
      if (initMatch) {
        const prefix = 'init'
        const tail = input.slice(prefix.length + 1).trim()
        const extraArgs = tail ? splitShellArgs(tail) : []
        if (shouldUseRemoteServer()) {
          const chatConfig = deps.kbConfig ?? (await readKbConfig())
          io.write('Starting init (remote server)…')
          const { exitCode } = await runRemoteSlashCommand(['init', ...extraArgs], line => {
            if (io.setProgressLine) io.setProgressLine(line.trimEnd())
            else io.write(line)
          }, chatConfig)
          io.setProgressLine?.(null)
          if (exitCode === 0) deps.onBaseChanged?.()
          printer.separator()
          continue
        }
        let parsed: ReturnType<typeof parseInitCommand>
        try {
          parsed = parseInitCommand(extraArgs)
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
            `✅ Init complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`
          )
          deps.onBaseChanged?.()
        } catch (err) {
          io.setProgressLine?.(null)
          if (isInitCancelledError(err)) {
            const baseName = deps.kbStorageDir ? path.basename(deps.kbStorageDir) : undefined
            io.write(initCancelledNotice(baseName))
            await initScanReporter.append(initScanCollector.finish('success', undefined)).catch(() => {})
          } else {
            const errMsg = err instanceof Error ? err.message : String(err)
            await initScanReporter.append(initScanCollector.finish('error', errMsg)).catch(() => {})
            io.error(`Init error: ${errMsg}`)
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
            '  /init --git <url> [args]  Clone and index a git remote into a KB base',
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
        sessionStats = createSessionStats(llmProvider.name, llmProvider.model, sessionBase)
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
          const subQueries = await decomposeQueryForRetrieval(input, llmProvider)
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
                      toolExecutor: toolExecutor,
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
          llmProvider: llmProvider,
          toolExecutor: toolExecutor,
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

function formatRetrievalMode(retrieval: ReadDocumentsResult['retrieval']): string {
  const method = retrieval?.method ?? 'unknown'
  const detail = retrieval?.detail ? ` (${retrieval.detail})` : ''
  return `${method}${detail}`
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
