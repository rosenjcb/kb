/**
 * CLI dispatch for `kb server start`.
 *
 * Builds the shared `KbService` once and keeps the process alive until a
 * shutdown signal.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { readBaseMeta } from '../cli/base-meta.js'
import { ensureOperationalBaseDir, readOptionalCliValue, resolveEffectiveBaseDir } from '../cli/base-selection.js'
import { runKbInit } from '../cli/init-cli.js'
import type { KbConfig } from '../cli/kb-config.js'
import { runScanCommand } from '../cli/scan-command.js'
import { kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { type BootstrapPlan, resolveBootstrapPlan } from './server-bootstrap.js'
import { createHttpServer } from './http-server.js'
import { createKbService } from './kb-service.js'
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
  /** The resolved base name (`--base` / env / manifest / effective) — used for init/scan args. */
  baseRef: string
}

/**
 * Resolve which base to build + serve. The name comes from the bootstrap plan
 * (`--base` flag > `KB_SERVER_BASE_NAME` / `KB_BASE` env > manifest `base`); when none is
 * declared, fall back to the effective base from local config (`kb base use`).
 */
async function resolveServerBaseDir(plan: BootstrapPlan): Promise<ResolvedBase> {
  if (plan.base) {
    return { baseDir: await ensureOperationalBaseDir(plan.base), baseRef: plan.base }
  }
  const resolved = await resolveEffectiveBaseDir()
  return { baseDir: resolved.baseDir, baseRef: resolved.baseName }
}

/**
 * Boot-build the index when the volume has none. Builds from the declared bootstrap
 * plan (`--git` flags, env, or a `kb-server.json` manifest — see `server-bootstrap.ts`)
 * on a fresh volume, or rescans the base's tracked repos when meta already exists.
 * Subsequent restarts reuse the persisted index — no reindex on boot. Runs before the
 * service so the index file exists when the tool registry opens it.
 */
async function ensureIndexBuilt(
  base: ResolvedBase,
  plan: BootstrapPlan,
  log: (line: string) => void
): Promise<void> {
  if (existsSync(kbIndexDbPath(base.baseDir))) return

  if (plan.gitTargets.length > 0) {
    log(
      `No index found; building "${base.baseRef}" from ${plan.source} (${plan.gitTargets.length} repo(s))…`
    )
    await runKbInit({
      base: base.baseRef,
      nonInteractive: true,
      gitTargets: plan.gitTargets,
      ignorePatterns: plan.ignore,
    })
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
    '⚠  No index and no repos configured. Declare repos via --git, KB_SERVER_BASE_GIT_REPOS ' +
      '(or KB_GIT_REPOS), or a kb-server.json manifest; run `kb init`; or POST /v1/reindex once a base tracks repos.'
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

/**
 * `kb server start [--base <name>] [--port <n>] [--with-mcp]
 *                  [--git <url[#branch]>]… [--branch <name>] [--bootstrap <file>]`
 */
export async function runServerCommand(
  args: string[],
  out: ServerLogger,
  config: KbConfig
): Promise<void> {
  const enableMcp = args.includes('--with-mcp')
  const portArg = readOptionalCliValue(args, '--port')
  const port = portArg ? Number.parseInt(portArg, 10) : Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT
  if (Number.isNaN(port) || port <= 0) {
    throw new Error('--port must be a positive integer')
  }

  const plan = await resolveBootstrapPlan(args)
  const base = await resolveServerBaseDir(plan)
  await ensureIndexBuilt(base, plan, line => out.log(line))

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
