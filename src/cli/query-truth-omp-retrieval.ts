import dayjs from 'dayjs'
import { createInMemoryOmpSession } from '../core/omp-runtime.js'
import type { RunCollector } from '../core/telemetry.js'
import type { ToolExecutor } from '../core/tool-registry.js'
import type { LLMProvider, ToolUseRequest } from '../core/types.js'
import { DefaultIntentRouter } from '../intents/router.js'
import type { ConsumerIntentEnvelope, IntentResult } from '../intents/types.js'
import type { ParsedIntentCommand } from './intent-cli.js'

const MAX_READ_DOCUMENTS_CALLS = 3

const OMP_QUERY_SYSTEM_PROMPT = [
  'You are the retrieval planner for the `kb query` command.',
  `You may only call the tool \`read_documents\` (up to ${MAX_READ_DOCUMENTS_CALLS} times total).`,
  'Your job is to gather the best possible evidence from the local KB for the user question.',
  'If the question is clearly outside what this project KB could contain (e.g. general philosophy unrelated to the repo),',
  'call `read_documents` at most once using the provided initial arguments, then stop — do not chase unrelated technical hits.',
  'If results are empty or off-topic, you may reformulate the `query` string for a follow-up `read_documents` call.',
  'Prefer the discovery depth and limit from the recommended first input unless you have a strong reason to adjust.',
  'Do not answer the user in prose; retrieval results are summarized downstream.',
].join(' ')

export interface RunQueryTruthOmpInput {
  parsed: ParsedIntentCommand
  toolExecutor: ToolExecutor
  workspaceDir: string
  llmProvider: LLMProvider
  collector?: RunCollector
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readDocumentsPayloadLooksUsable(data: unknown): boolean {
  if (!isRecord(data)) return false
  const results = data.results
  return Array.isArray(results) && results.length > 0
}

/**
 * **`query_truth`** retrieval via Oh My Pi in-memory agent: only `read_documents`, bounded calls,
 * same router-derived first `read_documents` input as the legacy intent loop.
 *
 * On failure, callers should fall back to `runIntentLoop` (deterministic escalation).
 */
export async function runQueryTruthRetrievalOmp(
  input: RunQueryTruthOmpInput
): Promise<IntentResult> {
  const { parsed, toolExecutor, llmProvider, collector } = input
  const envelope = parsed.envelope as ConsumerIntentEnvelope
  if (envelope.intent !== 'query_truth') {
    throw new Error('runQueryTruthRetrievalOmp requires query_truth intent')
  }

  const router = new DefaultIntentRouter(toolExecutor)
  const decision = await router.route(envelope)
  if (decision.selectedOperation !== 'read_documents') {
    throw new Error(
      `OMP query retrieval expected read_documents, got ${decision.selectedOperation}`
    )
  }

  const primaryInput = decision.operationInput
  const question =
    (typeof envelope.payload.originalQuery === 'string'
      ? envelope.payload.originalQuery
      : undefined) ??
    (typeof envelope.payload.query === 'string' ? envelope.payload.query : undefined) ??
    ''

  let readCalls = 0
  let lastReadResult: unknown

  const childExecutor: ToolExecutor = {
    register() {
      throw new Error('read-only registry in OMP query retrieval')
    },
    getTools() {
      return toolExecutor.getTools().filter(t => t.name === 'read_documents')
    },
    async execute(toolUse: ToolUseRequest) {
      if (toolUse.name !== 'read_documents') {
        throw new Error(`Tool '${toolUse.name}' is not available in OMP query retrieval`)
      }
      readCalls += 1
      if (readCalls > MAX_READ_DOCUMENTS_CALLS) {
        throw new Error(`read_documents exceeded max calls (${MAX_READ_DOCUMENTS_CALLS})`)
      }
      const result = await toolExecutor.execute(toolUse)
      if (readDocumentsPayloadLooksUsable(result)) {
        lastReadResult = result
      }
      return result
    },
  }

  const customTools = childExecutor.getTools().map(tool => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.schema as Record<string, unknown>,
    execute: async (toolCallId: string, toolParams: unknown) => {
      const result = await childExecutor.execute({
        id: toolCallId,
        name: tool.name,
        input: toolParams as Record<string, unknown>,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  }))

  const userPrompt = [
    'Use read_documents to retrieve evidence for the KB query pipeline.',
    '',
    `User question (for relevance; downstream code composes the final answer): ${question}`,
    '',
    'Recommended first read_documents input (JSON):',
    JSON.stringify(primaryInput, null, 2),
  ].join('\n')

  const model = { provider: llmProvider.name, id: llmProvider.model } as never
  const startedAt = dayjs().toISOString()
  const startMs = Date.now()

  const { session } = await createInMemoryOmpSession({
    cwd: input.workspaceDir,
    model,
    customTools,
    enableMCP: false,
    enableLsp: false,
    systemPrompt: OMP_QUERY_SYSTEM_PROMPT,
  })

  try {
    await session.prompt(userPrompt, { attribution: 'user' })
    await session.waitForIdle()
  } finally {
    await session.dispose()
  }

  const durationMs = Date.now() - startMs
  if (collector) {
    collector.addStage({
      stage: 'query_truth:omp-retrieval',
      startedAt,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      provider: llmProvider.name,
      model: llmProvider.model,
    })
  }

  if (!readDocumentsPayloadLooksUsable(lastReadResult)) {
    throw new Error('OMP query retrieval produced no usable read_documents payload')
  }

  const provenance: string[] = []
  const data = lastReadResult as { results?: Array<{ metadata?: { id?: string } }> }
  for (const row of data.results ?? []) {
    const id = row.metadata?.id
    if (id) provenance.push(id)
  }

  return {
    status: 'accepted',
    explanation: `${decision.policyReason}; omp-retrieval (${readCalls} read_documents call${readCalls === 1 ? '' : 's'})`,
    recommendedAction: 'read_documents',
    data: lastReadResult,
    provenance,
    confidence: 0.72,
  }
}
