import { DatabaseSync } from 'node:sqlite'
import {
  MAX_FACT_CONTENT_CHARS,
  formatRetrievedFactsForLLM,
  formatToolQueryFactsForLLM,
} from '../core/retrieval-context.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider, Message, ToolDefinition } from '../core/types.js'
import type { IntentResult } from '../intents/types.js'
import { loadPrompt } from '../prompts/loader.js'
import type { ChatTrace } from '../service/chat-types.js'
import { DEFAULT_FACT_LIMIT } from '../tools/facts-query-research-orchestrator.js'
import { expandQueryWithGraph, kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { type Printer, createReasoningProgressSink } from '../ui/printer.js'
import { executeChatQueryTruthRetrieval } from './chat-query-orchestrator.js'
import type { CuratorAudit } from './intent-cli.js'
import { formatCuratorResearchNotes, isReadFactsResult } from './intent-cli.js'
import { PROCEDURAL_SYNTHESIS_GUIDANCE, isProceduralQuestion } from './procedural-intent.js'

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

// If a thinking model consumes this whole budget reasoning and leaves no answer,
// GeminiProvider.call() escalates the budget (and, failing that, retries with
// thinking disabled), so this stays at the lean default.
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

// Final-answer synthesis (Alt A): a dedicated pass, separate from the tool-routing
// loop. No tools, no reasoning budget — the model just writes the answer from the
// facts already gathered, with the full output budget available for the answer.
const CHAT_SYNTHESIS_SYSTEM_PROMPT = [
  'You are KB, a knowledge base assistant backed by a codebase knowledge graph.',
  'Using ONLY the facts gathered in this conversation plus the prior turns, write the',
  "final answer to the user's most recent question.",
  '',
  '- Answer directly as a domain expert. Never mention retrieval, tools, or "the facts provided".',
  '- Name concrete files, functions, flags, or settings inline so the reader can verify.',
  '- Format for the reader: a tight paragraph for simple questions; headings/bullets/a compact',
  '  table for multi-part ones. Bold key terms.',
  '- If the gathered facts genuinely do not contain the answer, say so briefly and suggest',
  '  running `kb query "<topic>"`. Do not invent details.',
].join('\n')

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
  /** Structured trace hook — one line per routing decision / tool call / answer. */
  trace?: ChatTrace
}): Promise<ChatSynthesisResult> {
  const trace: ChatTrace = params.trace ?? (() => {})
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
  const started = Date.now()
  let factsRetrieved = params.retrieval?.results?.length ?? 0
  let lastIntentResult: IntentResult | undefined
  let round = 0
  let directAnswer = ''
  const gatheredFactBlocks: string[] = []

  trace('received', { chars: params.question.length })

  // Phase 1 — routing/retrieval. The model decides which query_kb calls to make;
  // bounded reasoning is allowed here, but this phase does NOT write the answer.
  while (true) {
    const stageName = round === 0 ? 'route' : `route-r${round + 1}`
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

    const toolCalls = completion.stopReason === 'tool_use' ? completion.toolUses.length : 0
    trace('route', {
      round,
      stopReason: completion.stopReason,
      toolCalls,
      textChars: completion.text.trim().length,
    })

    if (
      completion.stopReason !== 'tool_use' ||
      completion.toolUses.length === 0 ||
      round >= MAX_SYNTHESIS_TURNS
    ) {
      // Model answered directly (greeting/meta) or hit the turn cap.
      directAnswer = completion.text
      break
    }

    const toolResultBlocks = await Promise.all(
      completion.toolUses.map(async toolUse => {
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
        trace('tool_call', { q })

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

    for (const block of toolResultBlocks) {
      const r = typeof block.result === 'string' ? block.result : ''
      if (r && r !== 'No facts found.' && r !== 'Unknown tool.' && r !== 'Empty query.') {
        gatheredFactBlocks.push(r)
      }
    }
    trace('tool_result', { queries: completion.toolUses.length, facts: factsRetrieved })

    turnMessages = [
      ...turnMessages,
      { role: 'assistant' as const, content: completion.text, toolUses: completion.toolUses },
      { role: 'user' as const, content: toolResultBlocks },
    ]
  }

  // Phase 2 — final synthesis (Alt A): thinking OFF (no onReasoning), no tools, full
  // output budget. The model writes the answer from the gathered facts. Skipped only
  // when the model answered directly with no retrieval (e.g. a greeting) and gave text.
  let completionText = directAnswer
  if (gatheredFactBlocks.length > 0 || !completionText.trim()) {
    const factsContext = gatheredFactBlocks.length
      ? gatheredFactBlocks.join('\n\n')
      : '(no facts retrieved)'
    trace('synthesis', { factBlocks: gatheredFactBlocks.length, facts: factsRetrieved })
    const synthMessages: Message[] = [
      ...params.messages,
      {
        role: 'user',
        content: `Knowledge base facts gathered for the question above:\n\n${factsContext}\n\nUsing only these facts and the conversation so far, write the final answer now.`,
      },
    ]
    const synthRun = await withStageProgress(
      params.printer,
      'synthesis',
      () =>
        params.llmProvider.call({
          messages: synthMessages,
          systemPrompt: CHAT_SYNTHESIS_SYSTEM_PROMPT,
          temperature: 0.15,
          maxTokens: CHAT_MAX_OUTPUT_TOKENS,
        }),
      { heartbeatMs, noticeMs }
    )
    totalInputTokens += synthRun.result.usage.inputTokens
    totalOutputTokens += synthRun.result.usage.outputTokens
    if (synthRun.result.text.trim()) completionText = synthRun.result.text
  }

  const answered = completionText.trim().length > 0
  trace(answered ? 'answer' : 'no_answer', {
    chars: completionText.trim().length,
    facts: factsRetrieved,
  })

  return {
    answer:
      completionText.trim() || "I don't have enough information to answer that. Try rephrasing.",
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

  const proceduralGuidance = isProceduralQuestion(input.question)
    ? PROCEDURAL_SYNTHESIS_GUIDANCE
    : ''

  return [
    graphSection,
    proceduralGuidance,
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
