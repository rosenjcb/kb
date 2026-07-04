import type { KbConfig } from '@kb/core/config/kb-config.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import { getIntentQuestion, isIntentCommand, parseIntentCommand } from '@kb/core/query/intent-cli.js'
import type { CmdMode } from '@kb/core/config/cmd-ref.js'
import { createKbApiClient } from '../api/kb-api-client.js'
import { isLocalMode, resolveServerConnection } from '../api/server-connection.js'
import type { CliOutput } from '@kb/core/ui/cli-output.js'
import { createPrinter } from '../ui/printer.js'
import type { ChatIO, ChatSessionDeps } from './chat-cli.js'

/** Client-only commands — never forwarded to kb-server. */
export function isClientLocalCommand(args: string[]): boolean {
  const command = args[0]
  if (!command) return false
  if (command === '--version' || command === '-v' || command === 'version') return true
  if (command === 'config' || command === 'skills' || command === 'uninstall' || command === 'sync') {
    return true
  }
  if (command === 'base' && args[1] === 'use') return true
  return false
}

export function shouldUseRemoteServer(): boolean {
  return !isLocalMode()
}

export async function ensureServerReady(config: KbConfig): Promise<void> {
  const connection = resolveServerConnection(config)
  const client = createKbApiClient(connection)
  await client.connect()
}

export async function runRemoteAdminCli(
  args: string[],
  out: CliOutput,
  config?: KbConfig,
): Promise<{ exitCode: number }> {
  const kbConfig = config ?? (await readKbConfig())
  const client = createKbApiClient(resolveServerConnection(kbConfig))
  await client.connect()
  const result = await client.adminCli(args)
  if (result.output.trim()) {
    if (result.exitCode === 0) out.log(result.output)
    else out.error(result.output)
  }
  return { exitCode: result.exitCode }
}

export async function runRemoteCliCommand(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode,
): Promise<void> {
  if (isIntentCommand(args[0] ?? '')) {
    await runRemoteIntentCommand(args, out, config, mode)
    return
  }

  const client = createKbApiClient(resolveServerConnection(config))
  await client.connect()
  const result = await client.adminCli(args)
  if (result.output.trim()) {
    if (result.exitCode === 0) {
      if (args[0] === 'docs' && (args[1] === 'view' || args[1] === 'list')) {
        out.write(result.output)
      } else {
        out.log(result.output)
      }
    } else {
      out.error(result.output.startsWith('❌') ? result.output : `❌ ${result.output}`)
    }
  }
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
    out.error('Remote mode supports `kb query` for intent commands.')
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
  const type = typeof payload.type === 'string' ? payload.type : undefined
  const verbose = parsed.verbose === true

  const printer = createPrinter(out, mode)
  printer.startSpinner('querying kb server...')
  try {
    const result = await client.query({
      q: question,
      synthesize: !parsed.allFacts,
      limit,
      discovery,
      type,
      verbose,
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
      printer.metadata(
        'Retrieval',
        `${result.retrieval.method}${result.retrieval.detail ? ` (${result.retrieval.detail})` : ''}`,
      )
    }
    if (verbose && typeof result.confidence === 'number') {
      printer.metadata('Confidence', result.confidence.toFixed(2))
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
      const { sessionId: nextSession, answer } = await runRemoteChatTurn(
        input,
        sessionId,
        {
          log: line => io.write(line),
          write: line => io.write(line),
          error: line => io.error(line),
          progress: line => io.setProgressLine?.(line ?? null),
        },
        kbConfig,
      )
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

/** Run `/init` or `/scan` (or any argv list) on kb-server via REST. */
export async function runRemoteSlashCommand(
  argv: string[],
  write: (line: string) => void,
  config: KbConfig,
): Promise<{ exitCode: number }> {
  const client = createKbApiClient(resolveServerConnection(config))
  await client.connect()
  const result = await client.adminCli(argv)
  if (result.output.trim()) {
    for (const line of result.output.split('\n')) {
      write(line)
    }
  }
  return { exitCode: result.exitCode }
}
