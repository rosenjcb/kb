/**
 * CLI dispatch for `kb server start`.
 *
 * Builds the shared `KbService` once and keeps the process alive until a
 * shutdown signal.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { readBaseMeta, repoSlugFromGitUrl } from '../cli/base-meta.js'
import { ensureOperationalBaseDir, readOptionalCliValue, resolveEffectiveBaseDir } from '../cli/base-selection.js'
import { runKbInit } from '../cli/init-cli.js'
import { getKbConfigDir, type KbConfig } from '../cli/kb-config.js'
import { runScanCommand } from '../cli/scan-command.js'
import { kbIndexDbPath } from '../tools/graph-query-expansion.js'
import { type BootstrapPlan, resolveBootstrapPlan } from './server-bootstrap.js'
import { createHttpServer } from './http-server.js'
import { createKbService } from './kb-service.js'
import { parseDuration, startReindexScheduler } from './reindex-scheduler.js'
import { log } from './logger.js'

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

interface BootstrapTask {
  startMessage: string
  successMessage: string
  run(): Promise<void>
}

/**
 * Decide whether this node needs background bootstrap work after it begins listening.
 * Fresh volumes build/scan in the background so `/healthz` can come up immediately for
 * startup probes; warm volumes can optionally fold in newly declared repos.
 */
async function planBootstrapTask(
  base: ResolvedBase,
  plan: BootstrapPlan,
  log: (line: string) => void
): Promise<BootstrapTask | null> {
  if (existsSync(kbIndexDbPath(base.baseDir))) {
    return await planNewRepoSync(base, plan, log)
  }

  if (plan.gitTargets.length > 0) {
    return {
      startMessage: `No index found; building "${base.baseRef}" from ${plan.source} (${plan.gitTargets.length} repo(s)) in the background…`,
      successMessage: 'Index build complete.',
      run: async () => {
        await runKbInit({
          base: base.baseRef,
          nonInteractive: true,
          gitTargets: plan.gitTargets,
          ignorePatterns: plan.ignore,
          progressSink: log,
        })
      },
    }
  }

  const meta = await readBaseMeta(base.baseDir)
  if (meta && meta.repos.length > 0) {
    return {
      startMessage: `No index found; scanning ${meta.repos.length} tracked repo(s) in the background…`,
      successMessage: 'Index build complete.',
      run: async () => {
        await runScanCommand(['--base', base.baseRef], log)
      },
    }
  }

  log(
    '⚠  No index and no repos configured. Declare repos via --git, KB_SERVER_BASE_GIT_REPOS ' +
      '(or KB_GIT_REPOS), or a kb-server.json manifest; run `kb init`; or POST /v1/reindex once a base tracks repos.'
  )
  return null
}

/**
 * On a warm volume, fold in any repos the plan declares that the base doesn't yet track.
 * No-ops (fast restart) when nothing new is declared; otherwise idempotent `kb init` swaps to
 * the base, re-syncs it, and clones + indexes the new remotes. Routine refresh of already-
 * tracked repos is left to the reindex scheduler, not boot.
 */
async function planNewRepoSync(
  base: ResolvedBase,
  plan: BootstrapPlan,
  log: (line: string) => void,
): Promise<BootstrapTask | null> {
  if (plan.gitTargets.length === 0) return null
  const meta = await readBaseMeta(base.baseDir)
  const tracked = new Set((meta?.repos ?? []).map(repo => repo.slug))
  const newCount = plan.gitTargets.filter(t => !tracked.has(repoSlugFromGitUrl(t.url))).length
  if (newCount === 0) return null

  return {
    startMessage: `Index present; folding in ${newCount} newly-declared repo(s) from ${plan.source} in the background…`,
    successMessage: 'Repo sync complete.',
    run: async () => {
      await runKbInit({
        base: base.baseRef,
        nonInteractive: true,
        gitTargets: plan.gitTargets,
        ignorePatterns: plan.ignore,
        progressSink: log,
      })
    },
  }
}

/** Wait for SIGINT/SIGTERM, then run cleanup and resolve. */
function waitForShutdown(cleanup: () => Promise<void> | void): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const shutdown = async (signal: string) => {
      if (done) return
      done = true
      log.info('server shutdown', { signal })
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
  let settleBootstrap!: () => void
  const bootstrapSettled = new Promise<void>(resolve => {
    settleBootstrap = resolve
  })
  const bootstrapState = {
    indexing: false as boolean,
    error: undefined as string | undefined,
    progressLine: undefined as string | undefined,
    settled: bootstrapSettled,
  }
  const recordBootstrapProgress = (line: string): void => {
    bootstrapState.progressLine = line
    out.log(line)
  }
  const bootstrapTask = await planBootstrapTask(base, plan, line => recordBootstrapProgress(line))
  if (bootstrapTask) bootstrapState.indexing = true

  const service = createKbService({ baseDir: base.baseDir, config, bootstrapState })
  const apiKeys = readApiKeys()
  if (apiKeys.length === 0) {
    out.error('⚠  KB_SERVER_API_KEY is not set — /v1 and /mcp are UNAUTHENTICATED.')
    log.warn('no api key configured — /v1 and /mcp are unauthenticated')
  }

  const intervalMs = parseDuration(process.env.KB_REINDEX_INTERVAL)
  if (intervalMs === undefined) {
    throw new Error(`Invalid KB_REINDEX_INTERVAL: ${process.env.KB_REINDEX_INTERVAL}`)
  }
  const scheduler = startReindexScheduler({
    intervalMs,
    runReindex: async onProgress => {
      if (bootstrapState.indexing) {
        onProgress?.('skipped: bootstrap indexing still in progress')
        return undefined
      }
      return await service.reindex(onProgress)
    },
    onLog: line => {
      out.error(line)
      log.info(line)
    },
  })

  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET?.trim()
  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim()
  const slack =
    slackSigningSecret && slackBotToken
      ? { signingSecret: slackSigningSecret, botToken: slackBotToken }
      : undefined
  if (slackSigningSecret && !slackBotToken) {
    out.error('⚠  SLACK_SIGNING_SECRET is set but SLACK_BOT_TOKEN is missing — Slack integration disabled.')
  }
  if (slackBotToken && !slackSigningSecret) {
    out.error('⚠  SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is missing — Slack integration disabled.')
  }

  const server = createHttpServer({
    service,
    apiKeys,
    enableMcp,
    slack,
    logsDir: path.join(getKbConfigDir(), 'logs'),
    onLog: line => {
      out.error(line)
      log.error(line)
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })

  const health = service.health()
  log.info('server start', {
    port,
    base: path.basename(base.baseDir),
    provider: health.provider,
    model: health.model,
    mcp: enableMcp,
    slack: !!slack,
    apiKeys: apiKeys.length,
    reindexIntervalMs: intervalMs,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  })

  out.log(`🚀 kb server listening on :${port} (base "${path.basename(base.baseDir)}")`)
  out.log(
    `   POST /v1/query   POST /v1/chat   GET /healthz   POST /v1/reindex${enableMcp ? '   POST /mcp' : ''}${slack ? '   POST /slack/events' : ''}`
  )

  if (bootstrapTask) {
    bootstrapState.progressLine = bootstrapTask.startMessage
    out.log(bootstrapTask.startMessage)
    void (async () => {
      try {
        await bootstrapTask.run()
        out.log(bootstrapTask.successMessage)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        bootstrapState.error = message
        out.error(`⚠  Background bootstrap failed: ${message}`)
        log.error('background bootstrap failed', { error: message, base: path.basename(base.baseDir) })
      } finally {
        bootstrapState.indexing = false
        settleBootstrap()
      }
    })()
  } else {
    settleBootstrap()
  }

  await waitForShutdown(async () => {
    scheduler.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await service.close()
  })
}
