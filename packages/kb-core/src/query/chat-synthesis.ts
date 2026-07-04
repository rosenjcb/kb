import { DatabaseSync } from 'node:sqlite'
import {
  formatRetrievedFactsForLLM,
  formatToolQueryFactsForLLM,
  MAX_FACT_CONTENT_CHARS,
} from '../core/retrieval-context.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider, Message, ToolDefinition } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import { loadPrompt } from '../prompts/loader.js'
import { DEFAULT_FACT_LIMIT } from '../tools/facts-query-research-orchestrator.js'
import { expandQueryWithGraph, kbIndexDbPath } from '../tools/graph-query-expansion.js'
import {
  type Printer,
  createReasoningProgressSink,
} from '../ui/printer.js'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import type { CuratorAudit } from './intent-cli.js'
import {
  formatCuratorResearchNotes,
  isReadFactsResult,
} from './intent-cli.js'

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
    curation?: CuratorAudit
  }
}

export interface ChatSynthesisResult {
  answer: string
  inputTokens: number
  outputTokens: number
  answerMs: number
  factsRetrieved: number
  lastIntentResult?: IntentResult
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

const CHAT_ROUTER_SYSTEM_PROMPT = loadPrompt('chat-router-system.md')

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

export async function withStageProgress<T>(
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
    printer.clearProgress()
  }
}

export async function runChatSynthesis(params: {
  question: string
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
  const retrievalLimit = params.retrievalLimit ?? DEFAULT_FACT_LIMIT

  if (params.retrieval !== undefined && shouldRefuseChatTurnOnRetrieval(params.retrieval)) {
    return {
      answer: CHAT_WEAK_RETRIEVAL_REFUSAL,
      inputTokens: 0,
      outputTokens: 0,
      answerMs: 0,
      factsRetrieved: params.retrieval.results?.length ?? 0,
    }
  }

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

export function buildChatTurnContent(input: {
  question: string
  retrieval: ReadDocumentsResult
  graphRelationBlock?: string
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

  return [
    graphSection,
    `Retrieved evidence:\n${evidence}`,
    '',
    `User question: ${input.question}`,
  ]
    .filter(Boolean)
    .join('\n')
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

function buildEvidence(results: ReadDocumentsResult['results'], _allFacts?: boolean): string {
  return formatRetrievedFactsForLLM(results, { maxContentChars: MAX_FACT_CONTENT_CHARS })
}

export function buildToolQueryResult(snapshot: ReadDocumentsResult): string {
  const results = snapshot.results ?? []
  const lines = formatToolQueryFactsForLLM(results)
  if (results.length === 0) return lines
  const notes = formatCuratorResearchNotes(snapshot.retrieval?.curation)
  const withNotes = notes ? `${lines}\n\n${notes}` : lines
  const detail = snapshot.retrieval?.detail ?? ''
  const isWeakEvidence = detail.includes('weak_evidence_after_exhaustion')
  const isFrontierExhausted = detail.includes('frontier_exhausted')
  if (isWeakEvidence) {
    return `${withNotes}\n\n[Retrieval confidence was low — the graph frontier was exhausted without strong evidence. Try querying with different or broader terms before answering.]`
  }
  if (isFrontierExhausted) {
    return `${withNotes}\n\n[Graph frontier exhausted — all reachable nodes from initial query seeds were visited. If the above facts don't fully answer the question, try at least two more queries using specific technical identifiers (function names, file paths, constant names) rather than natural-language descriptions.]`
  }
  return withNotes
}
