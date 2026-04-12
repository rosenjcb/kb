import { createInterface } from 'node:readline/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolExecutor } from '../core/tool-registry'
import type { LLMProvider } from '../core/types'

export interface ChatSessionDeps {
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
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
  }
}

const HELP_TEXT = [
  'assistant> Commands:',
  'assistant>   /help  Show chat commands',
  'assistant>   /exit  Exit chat mode',
].join('\n')

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
        const readResult = await deps.toolExecutor.execute({
          id: `chat-read-${Date.now()}`,
          name: 'read_documents',
          input: {
            query: input,
            mode: 'content',
            includeContent: true,
            limit: retrievalLimit,
          },
        })

        const retrieval = normalizeReadResult(readResult)
        const retrievalWithFallback = await augmentRetrievalWithWorkspaceFallback(
          input,
          retrieval,
          deps.workspaceDir ?? process.cwd(),
        )
        const prompt = buildChatPrompt({
          question: input,
          retrieval: retrievalWithFallback,
          history,
        })

        const completion = await deps.llmProvider.call({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
          maxTokens: 320,
        })

        const answer = completion.text.trim() || 'I do not have enough evidence to answer that yet.'
        io.write(`assistant> ${answer}`)
        io.write(`retrieval> ${formatRetrievalMode(retrievalWithFallback.retrieval)}`)
        io.write(`sources> ${formatSourceIds(retrievalWithFallback.results).join(', ') || 'none'}`)

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
    'If evidence is weak or missing, say that explicitly and suggest what to query next.',
    '',
    `Conversation history:\n${historyText}`,
    '',
    `Retrieved evidence:\n${evidence}`,
    '',
    `Current user question: ${input.question}`,
  ].join('\n')
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
  if (!shouldUseWorkspaceFallback(question, retrieval.results)) {
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
    },
  }
}

function shouldUseWorkspaceFallback(
  question: string,
  results: ReadDocumentsResult['results'],
): boolean {
  if (!isBroadProjectQuestion(question)) {
    return false
  }

  if (!results || results.length === 0) {
    return true
  }

  const ids = formatSourceIds(results)
  if (ids.length === 0) {
    return true
  }

  return ids.every(id => id.startsWith('ticket-'))
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

function formatRetrievalMode(retrieval: ReadDocumentsResult['retrieval']): string {
  const method = retrieval?.method ?? 'unknown'
  const detail = retrieval?.detail ? ` (${retrieval.detail})` : ''
  return `${method}${detail}`
}

function formatSourceIds(results: ReadDocumentsResult['results']): string[] {
  if (!Array.isArray(results) || results.length === 0) return []

  const ids = results
    .map(result => result.metadata?.id)
    .filter((value): value is string => Boolean(value))

  return [...new Set(ids)].slice(0, 5)
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