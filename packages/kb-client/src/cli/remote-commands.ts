import type { KbConfig } from '@kb/core/config/kb-config.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import {
  getIntentQuestion,
  isIntentCommand,
  parseIntentCommand,
} from '@kb/core/query/intent-cli.js'
import type { CmdMode } from '@kb/core/config/cmd-ref.js'
import { createKbApiClient } from '../api/kb-api-client.js'
import type {
  ChatStreamEvent,
  GroupedSource,
  LeanSource,
  LLMFailureResponse,
} from '../api/types.js'
import {
  resolveActiveBaseName,
  resolveServerConnection,
  resolveServerConnectionWithBase,
  formatConnectionContext,
} from '../api/server-connection.js'
import type { CliOutput } from '@kb/core/ui/cli-output.js'
import { createPrinter } from '../ui/printer.js'
import type { ChatIO, ChatSessionDeps } from './chat-cli.js'

/**
 * Normalize either citation shape (lean `{path}` or full `GroupedSource`) to the
 * fields the CLI renders. The query command requests `verbose: true`, so it
 * receives `GroupedSource` (with `label`/`href`), but accept both so the renderer
 * never breaks if a lean payload arrives.
 */
function citationParts(source: LeanSource | GroupedSource): {
  label: string
  href?: string
  symbols?: string[]
} {
  if ('label' in source) {
    return { label: source.label, href: source.href, symbols: source.symbols }
  }
  // Lean payloads carry `href` too, so the CLI links them the same as verbose ones.
  return { label: source.path, href: source.href, symbols: source.symbols }
}

/**
 * One-line rendering of a server-reported synthesis failure.
 *
 * Kept local rather than importing the core formatter: the client models server
 * responses with loose types on purpose, so it keeps working against a server whose
 * failure vocabulary is newer than its own.
 */
function describeQueryFailure(failure: LLMFailureResponse): string {
  const where = failure.provider ? ` from ${failure.provider}` : ''
  const hint =
    failure.kind === 'insufficient_credits' || failure.kind === 'auth'
      ? ' Check the provider API key and billing status.'
      : failure.retryable
        ? ' This is usually transient — retry shortly.'
        : ''
  return `Answer synthesis failed (${failure.kind})${where}: ${failure.message}.${hint}`.replace(
    /\.\.($| )/,
    '$1'
  )
}

/** Client-only commands — never forwarded to kb-server. */
export function isClientLocalCommand(args: string[]): boolean {
  const command = args[0]
  if (!command) return false
  if (command === '--version' || command === '-v' || command === 'version') return true
  // mcp / skills / uninstall / sync rewrite local agent configs — server has no handlers.
  if (command === 'mcp' || command === 'skills' || command === 'uninstall' || command === 'sync') {
    return true
  }
  // `base use` is client connection-profile state; `base --help` stays offline.
  // `base delete` is refused client-side (deletion is an operator action on kb-server),
  // so keep it local instead of forwarding. `base list` runs on kb-server.
  if (command === 'base') {
    const sub = args[1]
    if (sub === 'use') return true
    if (sub === 'delete') return true
    if (sub === '--help' || sub === '-h' || sub === 'help') return true
  }
  return false
}

export async function ensureServerReady(config: KbConfig): Promise<void> {
  const connection = await resolveServerConnectionWithBase(config)
  const client = createKbApiClient(connection)
  await client.connect()
}

/**
 * Discover the server's own default base for display when no base was resolved
 * locally (no `--base` and no active base). Best-effort: an
 * unreachable server just leaves the caller's existing "(none)" display as-is —
 * the actual command still gets a real connection error later.
 */
export async function discoverRemoteDefaultBase(config: KbConfig): Promise<string | undefined> {
  try {
    const client = createKbApiClient(resolveServerConnection(config))
    const health = await client.connect()
    return health.base || undefined
  } catch {
    return undefined
  }
}

export interface DisplayBase {
  /** Base name to show, or undefined when the server is unreachable. */
  name?: string
  /** True when `name` is the server's own default base rather than a locally chosen active base. */
  isServerDefault: boolean
}

/**
 * Resolve the base to *display* (TUI status bar, CLI banner, chat header). It is the
 * active base — what the wire sends as `X-KB-Base` — when one is selected; otherwise
 * the server's own default base, discovered over the wire. Surfacing the server default
 * (instead of "(none)") makes the base flow obvious: with no `kb base use <base>` you are
 * on the server's default, never truly baseless. Best-effort: an unreachable server
 * leaves `name` undefined and callers fall back to "(none)".
 */
export async function resolveDisplayBase(config: KbConfig, cwd?: string): Promise<DisplayBase> {
  const active = await resolveActiveBaseName(config, cwd)
  if (active) return { name: active, isServerDefault: false }
  const serverDefault = await discoverRemoteDefaultBase(config)
  return { name: serverDefault, isServerDefault: serverDefault !== undefined }
}

export async function runRemoteAdminCli(
  args: string[],
  out: CliOutput,
  config?: KbConfig
): Promise<{ exitCode: number }> {
  const kbConfig = config ?? (await readKbConfig())
  const client = createKbApiClient(await resolveServerConnectionWithBase(kbConfig))
  await client.connect()
  const result = await client.adminCli(args)
  if (result.output.trim()) {
    if (result.exitCode === 0) out.log(result.output)
    else out.error(result.output)
  }
  return { exitCode: result.exitCode }
}

/** Returns the process exit code (0 = success) so the CLI can propagate failures. */
export async function runRemoteCliCommand(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode
): Promise<number> {
  if (isIntentCommand(args[0] ?? '')) {
    return await runRemoteIntentCommand(args, out, config, mode)
  }

  const client = createKbApiClient(await resolveServerConnectionWithBase(config))
  await client.connect()
  const result = await client.adminCli(args)
  if (result.output.trim()) {
    if (result.exitCode === 0) {
      out.log(result.output)
    } else {
      out.error(result.output.startsWith('❌') ? result.output : `❌ ${result.output}`)
    }
  }
  return result.exitCode
}

/** Returns the process exit code (0 = success, 1 = failure). */
export async function runRemoteIntentCommand(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode
): Promise<number> {
  const connection = await resolveServerConnectionWithBase(config)
  const client = createKbApiClient(connection)
  await client.connect()

  const parsed = parseIntentCommand(args)
  if (parsed.envelope.intent !== 'query_truth') {
    out.error('Remote mode supports `kb query` for intent commands.')
    return 1
  }

  const question = getIntentQuestion(parsed).trim()
  if (!question) {
    out.error('Query text is required.')
    return 1
  }

  const payload = parsed.envelope.payload
  const discoveryDepth = payload.discoveryDepth
  const discovery =
    discoveryDepth === 'shallow' || discoveryDepth === 'deep' ? discoveryDepth : undefined
  const verbose = parsed.verbose === true
  const trace = parsed.trace === true

  const printer = createPrinter(out, mode)
  printer.startSpinner('querying kb server...')
  try {
    // REST defaults to the lean agent payload; humans still want results +
    // retrieval footer, so always request the full evidence dump over the wire.
    const result = await client.query({
      q: question,
      synthesize: !parsed.allFacts,
      discovery,
      verbose: true,
      trace,
    })
    printer.stopSpinner()
    if (result.answer?.trim()) {
      printer.content(result.answer.trim())
    }
    // Sources without an answer used to print as a bare metadata footer and exit 0, which
    // reads as "nothing worth saying". Say what actually happened, and fail the command so
    // scripts and CI notice an outage instead of treating it as an empty result.
    const results = result.results ?? []
    if (!result.answer?.trim() && result.answerError) {
      out.error(`❌ ${describeQueryFailure(result.answerError)}`)
      if (results.length > 0) {
        out.error(
          `   Retrieval succeeded — ${results.length} source(s) found. Re-run the query to synthesize an answer.`
        )
      }
      return 1
    }
    // Caveats computed once server-side (verify hints, ungrounded-file /
    // unsupported-claim warnings, degraded retrieval) — the same `notes` the MCP
    // and demo surfaces carry, rendered here as ⚠️ lines.
    for (const note of result.notes ?? []) {
      out.error(`⚠️  ${note}`)
    }
    // Source-centric citations grouped once server-side, with blob hrefs — shown
    // as clickable OSC-8 links in a TTY, plain paths when piped.
    const sources = result.sources ?? []
    if (sources.length > 0) {
      printer.separator()
      printer.metadata('Sources', String(sources.length))
      for (const source of sources.slice(0, 8)) {
        const { label, href, symbols } = citationParts(source)
        printer.sourceCitation(label, { href, symbols })
      }
    }
    if (result.retrieval?.method) {
      printer.metadata(
        'Retrieval',
        `${result.retrieval.method}${result.retrieval.detail ? ` (${result.retrieval.detail})` : ''}`
      )
    }
    if (verbose && result.evidence) {
      printer.metadata('Evidence', result.evidence)
    }
    if (result.traceFile) {
      out.log(`[kb] query trace written on server: ${result.traceFile}`)
    }
    return 0
  } catch (error) {
    printer.stopSpinner()
    const message = error instanceof Error ? error.message : String(error)
    out.error(`❌ ${message}`)
    return 1
  }
}

/**
 * Route one `/v1/chat` SSE event to CLI/TUI sinks.
 * `reasoning` → progress (thinking spinner); `meta` → log (stage lines).
 * Must stay split — merging both into progress lets stage heartbeats wipe thinking.
 */
export function dispatchRemoteChatStreamEvent(
  event: ChatStreamEvent,
  out: Pick<CliOutput, 'log' | 'progress'>,
  hooks: {
    onSession?: (sessionId: string) => void
    onAnswer?: (text: string) => void
  } = {}
): void {
  switch (event.type) {
    case 'session':
      hooks.onSession?.(event.sessionId)
      break
    case 'reasoning':
      out.progress?.(event.text)
      break
    case 'meta':
      out.log(event.text)
      break
    case 'answer':
      hooks.onAnswer?.(event.text)
      break
    case 'error':
      throw new Error(event.message)
    case 'done':
      break
  }
}

export async function runRemoteChatTurn(
  message: string,
  sessionId: string | undefined,
  out: CliOutput,
  config: KbConfig
): Promise<{ sessionId: string; answer: string }> {
  const client = createKbApiClient(await resolveServerConnectionWithBase(config))
  await client.connect()

  let activeSession = sessionId
  let answer = ''

  for await (const event of client.chatStream({ sessionId, message })) {
    dispatchRemoteChatStreamEvent(event, out, {
      onSession: id => {
        activeSession = id
      },
      onAnswer: text => {
        answer = text
      },
    })
  }

  return { sessionId: activeSession ?? sessionId ?? 'default', answer }
}

export async function runRemoteChatSession(deps: ChatSessionDeps, io: ChatIO): Promise<void> {
  const kbConfig = deps.kbConfig ?? (await readKbConfig())

  const display = await resolveDisplayBase(kbConfig)
  io.write(formatConnectionContext(kbConfig, display.name, { serverDefault: display.isServerDefault }))

  let sessionId: string | undefined

  while (true) {
    const raw = await io.read('you> ')
    if (raw === null) break
    const input = raw.trim()
    if (!input) continue
    if (input === '/exit' || input === '/quit') break
    // `/clear` starts a fresh server session rather than being answered as a question.
    // The prior session's turns are already persisted in run logs (snoop with `kb session`).
    if (input === '/clear') {
      sessionId = undefined
      continue
    }

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
        kbConfig
      )
      if (nextSession !== sessionId) deps.onSessionStart?.(nextSession)
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
  config: KbConfig
): Promise<{ exitCode: number }> {
  const client = createKbApiClient(await resolveServerConnectionWithBase(config))
  await client.connect()
  const result = await client.adminCli(argv)
  if (result.output.trim()) {
    for (const line of result.output.split('\n')) {
      write(line)
    }
  }
  return { exitCode: result.exitCode }
}
