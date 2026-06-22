/**
 * CLI dispatch for `kb server start` and `kb mcp start`.
 *
 * Both build the shared `KbService` once and keep the process alive until a
 * shutdown signal. The stdio MCP transport owns stdout for its JSON-RPC frames,
 * so MCP logs go to stderr only.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { readBaseMeta } from '../cli/base-meta.js'
import { ensureOperationalBaseDir, readOptionalCliValue, resolveEffectiveBaseDir } from '../cli/base-selection.js'
import { parseInitCommand, runKbInit } from '../cli/init-cli.js'
import type { KbConfig } from '../cli/kb-config.js'
import { runScanCommand } from '../cli/scan-command.js'
import { kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { createHttpServer } from './http-server.js'
import { createKbService, type KbService } from './kb-service.js'
import { startStdioMcpServer } from './mcp-server.js'
import { parseDuration, startReindexScheduler } from './reindex-scheduler.js'

export interface ServerLogger {
  log(message: string): void
  error(message: string): void
}

const DEFAULT_PORT = 8080

function readApiKeys(): string[] {
  return (process.env.KB_SERVER_API_KEY ?? '')
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0)
}

interface ResolvedBase {
  baseDir: string
  /** The `--base`/`KB_BASE` value or resolved base name — used for init/scan args. */
  baseRef: string
}

async function resolveServerBaseDir(args: string[]): Promise<ResolvedBase> {
  const base = readOptionalCliValue(args, '--base') ?? process.env.KB_BASE
  if (base) return { baseDir: await ensureOperationalBaseDir(base), baseRef: base }
  const resolved = await resolveEffectiveBaseDir()
  return { baseDir: resolved.baseDir, baseRef: resolved.baseName }
}

function parseGitRepos(): string[] {
  return (process.env.KB_GIT_REPOS ?? '')
    .split(',')
    .map(repo => repo.trim())
    .filter(repo => repo.length > 0)
}

/**
 * Boot-build the index when the volume has none. Builds from `KB_GIT_REPOS` (fresh
 * volume) or rescans the base's tracked repos (existing meta). Subsequent restarts
 * reuse the persisted index — no reindex on boot. Runs before the service so the
 * index file exists when the tool registry opens it.
 */
async function ensureIndexBuilt(base: ResolvedBase, log: (line: string) => void): Promise<void> {
  if (existsSync(kbIndexDbPath(base.baseDir))) return

  const repos = parseGitRepos()
  if (repos.length > 0) {
    log(`No index found; building from KB_GIT_REPOS (${repos.length} repo(s))…`)
    const initArgs = ['--base', base.baseRef, '--non-interactive', ...repos.flatMap(r => ['--git', r])]
    const options = parseInitCommand(initArgs)
    if (!options.base) options.base = base.baseRef
    await runKbInit(options)
    log('Index build complete.')
    return
  }

  const meta = await readBaseMeta(base.baseDir)
  if (meta && meta.repos.length > 0) {
    log(`No index found; scanning ${meta.repos.length} tracked repo(s)…`)
    await runScanCommand(['--base', base.baseRef], log)
    log('Index build complete.')
    return
  }

  log(
    '⚠  No index and no repos configured. Set KB_GIT_REPOS, run `kb init`, or POST /v1/reindex once a base tracks repos.'
  )
}

/** Wait for SIGINT/SIGTERM, then run cleanup and resolve. */
function waitForShutdown(cleanup: () => Promise<void> | void): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const shutdown = async (signal: string) => {
      if (done) return
      done = true
      process.stderr.write(`\n[kb] received ${signal}, shutting down…\n`)
      await cleanup()
      resolve()
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
  })
}

/** `kb server start [--base <name>] [--port <n>] [--mcp]` */
export async function runServerCommand(
  args: string[],
  out: ServerLogger,
  config: KbConfig
): Promise<void> {
  const enableMcp = args.includes('--mcp')
  const portArg = readOptionalCliValue(args, '--port')
  const port = portArg ? Number.parseInt(portArg, 10) : Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT
  if (Number.isNaN(port) || port <= 0) {
    throw new Error('--port must be a positive integer')
  }

  const base = await resolveServerBaseDir(args)
  await ensureIndexBuilt(base, line => out.log(line))

  const service = createKbService({ baseDir: base.baseDir, config })
  const apiKeys = readApiKeys()
  if (apiKeys.length === 0) {
    out.error('⚠  KB_SERVER_API_KEY is not set — /v1 and /mcp are UNAUTHENTICATED.')
  }

  const intervalMs = parseDuration(process.env.KB_REINDEX_INTERVAL)
  if (intervalMs === undefined) {
    throw new Error(`Invalid KB_REINDEX_INTERVAL: ${process.env.KB_REINDEX_INTERVAL}`)
  }
  const scheduler = startReindexScheduler({
    intervalMs,
    runReindex: onProgress => service.reindex(onProgress),
    onLog: line => out.error(line),
  })

  const server = createHttpServer({
    service,
    apiKeys,
    enableMcp,
    onLog: line => out.error(line),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })

  out.log(`🚀 kb server listening on :${port} (base "${path.basename(base.baseDir)}")`)
  out.log(
    `   POST /v1/query   POST /v1/chat   GET /healthz   POST /v1/reindex${enableMcp ? '   POST /mcp' : ''}`
  )

  await waitForShutdown(async () => {
    scheduler.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await service.close()
  })
}

/** `kb mcp start [--http] [--base <name>] [--port <n>]` */
export async function runMcpCommand(
  args: string[],
  out: ServerLogger,
  config: KbConfig
): Promise<void> {
  const base = await resolveServerBaseDir(args)

  if (args.includes('--http')) {
    await ensureIndexBuilt(base, line => out.log(line))
    const service: KbService = createKbService({ baseDir: base.baseDir, config })
    const portArg = readOptionalCliValue(args, '--port')
    const port = portArg ? Number.parseInt(portArg, 10) : Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT
    const apiKeys = readApiKeys()
    const server = createHttpServer({ service, apiKeys, enableMcp: true, onLog: line => out.error(line) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, () => resolve())
    })
    out.log(`🚀 kb MCP (Streamable HTTP) listening on :${port}/mcp (base "${path.basename(base.baseDir)}")`)
    await waitForShutdown(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await service.close()
    })
    return
  }

  // stdio: keep stdout clean for JSON-RPC; log to stderr only.
  await ensureIndexBuilt(base, line => out.error(line))
  const service: KbService = createKbService({ baseDir: base.baseDir, config })
  await startStdioMcpServer(service)
  process.stderr.write(`[kb] MCP stdio server ready (base "${path.basename(base.baseDir)}")\n`)
  await waitForShutdown(() => service.close())
}
