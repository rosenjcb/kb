import type { KbConfig } from '@kb/core/config/kb-config.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import { KB_ENV } from '@kb/core/config/kb-env.js'
import {
  getIntentQuestion,
  isIntentCommand,
  parseIntentCommand,
} from '@kb/core/query/intent-cli.js'
import { DEFAULT_BASE_SLUG, resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
import type { CmdMode } from '@kb/core/config/cmd-ref.js'
import { createKbApiClient } from '../api/kb-api-client.js'
import type {
  ChatStreamEvent,
  GroupedSource,
  LeanSource,
  LLMFailureResponse,
} from '../api/types.js'
import {
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

export interface DisplayBase {
  /** Base name to show — always set (see `resolveActiveBaseName`). */
  name: string
  /** True when neither `KB_BASE` nor a local active base was configured, i.e. `name` is the client's own unconfigured-fallback slug. */
  isFallback: boolean
}

/**
 * Resolve the base to *display* (TUI status bar, CLI banner, chat header) — the same
 * three tiers `resolveActiveBaseName` resolves for the wire, computed **locally, with
 * no network round-trip**. There is nothing to discover from the server: the client
 * always knows its own base before it ever connects (see `resolveActiveBaseName`'s doc
 * comment for why that's the correct "psql model" reading).
 */
export async function resolveDisplayBase(config: KbConfig, cwd?: string): Promise<DisplayBase> {
  void config
  const explicit = process.env[KB_ENV.BASE]?.trim()
  if (explicit) return { name: explicit, isFallback: false }
  try {
    const { baseName } = await resolveEffectiveBaseDir(cwd)
    if (baseName?.trim()) return { name: baseName.trim(), isFallback: false }
  } catch {
    // No active base selected locally.
  }
  return { name: DEFAULT_BASE_SLUG, isFallback: true }
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
    onSources?: (sources: GroupedSource[]) => void
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
      hooks.onSources?.(event.sources)
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
): Promise<{ sessionId: string; answer: string; sources: GroupedSource[] }> {
  const client = createKbApiClient(await resolveServerConnectionWithBase(config))
  await client.connect()

  let activeSession = sessionId
  let answer = ''
  let sources: GroupedSource[] = []

  for await (const event of client.chatStream({ sessionId, message })) {
    dispatchRemoteChatStreamEvent(event, out, {
      onSession: id => {
        activeSession = id
      },
      onAnswer: text => {
        answer = text
      },
      onSources: grouped => {
        sources = grouped
      },
    })
  }

  return { sessionId: activeSession ?? sessionId ?? 'default', answer, sources }
}

export async function runRemoteChatSession(deps: ChatSessionDeps, io: ChatIO): Promise<void> {
  const kbConfig = deps.kbConfig ?? (await readKbConfig())

  const display = await resolveDisplayBase(kbConfig)
  io.write(formatConnectionContext(kbConfig, display.name, { isFallback: display.isFallback }))

  const chatOut: CliOutput = {
    log: line => io.write(line),
    write: line => io.write(line),
    error: line => io.error(line),
    progress: line => io.setProgressLine?.(line ?? null),
  }
  // Same primitive shape `kb query` already renders (Sources count, then one
  // citation line per file) — built from the same grouped-source model MCP,
  // chat, and Slack all render from. Chat's SSE `answer` event carries it too;
  // this is the first surface that actually prints it instead of dropping it.
  const printer = createPrinter(chatOut, deps.mode ?? 'tui')

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
      const { sessionId: nextSession, answer, sources } = await runRemoteChatTurn(
        input,
        sessionId,
        chatOut,
        kbConfig
      )
      if (nextSession !== sessionId) deps.onSessionStart?.(nextSession)
      sessionId = nextSession
      io.setProgressLine?.(null)
      if (answer.trim()) io.write(answer.trim())
      if (sources.length > 0) {
        printer.metadata('Sources', String(sources.length))
        for (const source of sources.slice(0, 8)) {
          const { label, href, symbols } = citationParts(source)
          printer.sourceCitation(label, { href, symbols })
        }
      }
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
