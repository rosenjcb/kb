import type { KbConfig } from '@kb/core/config/kb-config.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import { getIntentQuestion, parseIntentCommand } from '@kb/core/query/intent-cli.js'
import type { CmdMode } from '@kb/core/config/cmd-ref.js'
import { createKbApiClient } from '../api/kb-api-client.js'
import { isLocalMode, resolveServerConnection } from '../api/server-connection.js'
import type { CliOutput } from './index.js'
import { createPrinter } from '../ui/printer.js'
import type { ChatIO, ChatSessionDeps } from './chat-cli.js'

export function shouldUseRemoteServer(): boolean {
  return !isLocalMode()
}

export async function ensureServerReady(config: KbConfig): Promise<void> {
  const connection = resolveServerConnection(config)
  const client = createKbApiClient(connection)
  await client.connect()
}

export async function runRemoteIntentCommand(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode,
): Promise<void> {
  const connection = resolveServerConnection(config)
  const client = createKbApiClient(connection)
  await client.connect()

  const parsed = parseIntentCommand(args)
  if (parsed.envelope.intent !== 'query_truth') {
    out.error('Remote mode supports `kb query` only. Set KB_LOCAL_MODE=1 for other intent commands.')
    return
  }

  const question = getIntentQuestion(parsed).trim()
  if (!question) {
    out.error('Query text is required.')
    return
  }

  const payload = parsed.envelope.payload
  const limit = typeof payload.limit === 'number' ? payload.limit : undefined
  const discoveryDepth = payload.discoveryDepth
  const discovery =
    discoveryDepth === 'shallow' || discoveryDepth === 'deep' ? discoveryDepth : undefined

  const printer = createPrinter(out, mode)
  printer.startSpinner('querying kb server...')
  try {
    const result = await client.query({
      q: question,
      synthesize: !parsed.allFacts,
      limit,
      discovery,
    })
    printer.stopSpinner()
    if (result.answer?.trim()) {
      printer.content(result.answer.trim())
    }
    if (result.results.length > 0) {
      printer.separator()
      printer.metadata('Sources', String(result.results.length))
      for (const source of result.results.slice(0, 8)) {
        const label = source.title || source.filePath || source.id || 'source'
        printer.metadata('Source', label)
      }
    }
    if (result.retrieval?.method) {
      printer.metadata('Retrieval', `${result.retrieval.method}${result.retrieval.detail ? ` (${result.retrieval.detail})` : ''}`)
    }
  } catch (error) {
    printer.stopSpinner()
    const message = error instanceof Error ? error.message : String(error)
    out.error(`❌ ${message}`)
  }
}

export async function runRemoteChatTurn(
  message: string,
  sessionId: string | undefined,
  out: CliOutput,
  config: KbConfig,
): Promise<{ sessionId: string; answer: string }> {
  const client = createKbApiClient(resolveServerConnection(config))
  await client.connect()

  let activeSession = sessionId
  let answer = ''

  for await (const event of client.chatStream({ sessionId, message })) {
    switch (event.type) {
      case 'session':
        activeSession = event.sessionId
        break
      case 'reasoning':
      case 'meta':
        out.progress?.(event.text)
        break
      case 'answer':
        answer = event.text
        break
      case 'error':
        throw new Error(event.message)
      case 'done':
        break
    }
  }

  return { sessionId: activeSession ?? sessionId ?? 'default', answer }
}

export async function runRemoteChatSession(deps: ChatSessionDeps, io: ChatIO): Promise<void> {
  const kbConfig = deps.kbConfig ?? (await readKbConfig())

  let sessionId: string | undefined
  io.write('Chat mode (remote server) — type /exit to quit.')

  while (true) {
    const raw = await io.read('you> ')
    if (raw === null) break
    const input = raw.trim()
    if (!input) continue
    if (input === '/exit' || input === '/quit') break

    try {
      const { sessionId: nextSession, answer } = await runRemoteChatTurn(input, sessionId, {
        log: line => io.write(line),
        write: line => io.write(line),
        error: line => io.error(line),
        progress: line => io.setProgressLine?.(line ?? null),
      }, kbConfig)
      sessionId = nextSession
      io.setProgressLine?.(null)
      if (answer.trim()) io.write(answer.trim())
    } catch (error) {
      io.setProgressLine?.(null)
      io.error(error instanceof Error ? error.message : String(error))
    }
  }
  io.close?.()
}
