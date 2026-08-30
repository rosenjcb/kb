/**
 * CLI dispatch for `kb-server start`.
 *
 * Builds the shared `KbService` once and keeps the process alive until a
 * shutdown signal.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  type KbConfig,
  getKbConfigDir,
  persistInferredLLMProvider,
} from '@kb/core/config/kb-config.js'
import { KB_ENV } from '@kb/core/config/kb-env.js'
import { DEFAULT_KB_SERVER_PORT } from '@kb/core/config/kb-server-port.js'
import {
  ReportWriter,
  RunCollector,
  costLogFields,
  defaultLogsDir,
} from '@kb/core/core/telemetry.js'
import { cloneRepo, isAncestorOfHead, resetToSha } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import { createKbService } from '@kb/core/service/kb-service.js'
import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import {
  DEFAULT_BASE_SLUG,
  ensureBaseExists,
  ensureOperationalBaseDir,
  readOptionalCliValue,
} from '@kb/core/storage/base-selection.js'
import { REPOS_SUBDIR, repoSlugFromGitUrl } from '@kb/core/storage/repo-slug.js'
import { type SnapshotRepoProvenance, readSnapshotManifest } from '@kb/core/storage/snapshot.js'
import { kbIndexDbPath } from '@kb/core/tools/kb-index-path.js'
import { streamChatTurn } from './chat-stream.js'
import {
  removePidFile,
  runServerRestart,
  runServerStartDaemon,
  runServerStatus,
  runServerStop,
  writePidFile,
} from './daemon-cli.js'
import { createHttpServer } from './http-server.js'
import { log } from './logger.js'
import { parseDuration, startReindexScheduler } from './reindex-scheduler.js'
import {
  type BootstrapPlan,
  type BootstrapPolicy,
  resolveBootstrapPlan,
  resolveBootstrapPolicy,
  resolveSnapshotSource,
} from './server-bootstrap.js'
import { createKbServiceRegistry } from './service-registry.js'
import { runServerUninstallCommand } from './uninstall-cli.js'
import { resolveServerVersion } from './version.js'

export interface ServerLogger {
  log(message: string): void
  error(message: string): void
}

const DEFAULT_PORT = DEFAULT_KB_SERVER_PORT

async function runIndexedOp(
  command: 'init' | 'scan',
  base: string,
  run: (collector: RunCollector) => Promise<void>
): Promise<void> {
  const collector = new RunCollector(command, { base })
  const reporter = new ReportWriter(defaultLogsDir())
  try {
    await run(collector)
    const report = collector.finish('success', undefined, base)
    await reporter.append(report)
    log.info(`${command} complete`, { base, ...costLogFields(report) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const report = collector.finish('error', message, base)
    await reporter.append(report)
    log.error(`${command} error`, { base, error: message, ...costLogFields(report) })
    throw error
  }
}

function isVersionArg(argv: string[]): boolean {
  return (
    argv.includes('--version') || argv.includes('-V') || argv[0] === 'version' || argv[0] === '-v'
  )
}

function readApiKeys(): string[] {
  return (process.env.KB_SERVER_API_KEY ?? '')
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0)
}

/**
 * Browser origins allowed to call the API cross-origin, from
 * `KB_SERVER_ALLOWED_ORIGINS` and/or repeatable `--allow-origin` flags
 * (each comma-separated). Enables the hosted "try it" chat page to reach this
 * server. A single `*` allows any origin. De-duplicated, order preserved.
 */
function readAllowedOrigins(args: string[]): string[] {
  const fromEnv = process.env.KB_SERVER_ALLOWED_ORIGINS ?? ''
  const fromFlags: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-origin' && i + 1 < args.length) fromFlags.push(args[i + 1])
  }
  const seen = new Set<string>()
  const origins: string[] = []
  for (const raw of [fromEnv, ...fromFlags]) {
    for (const origin of raw
      .split(',')
      .map(o => o.trim())
      .filter(o => o.length > 0)) {
      if (!seen.has(origin)) {
        seen.add(origin)
        origins.push(origin)
      }
    }
  }
  return origins
}

interface ResolvedBase {
  baseDir: string
  /** The resolved base name (`--base` / env / effective) — used for init/scan args. */
  baseRef: string
}

/**
 * Resolve which base to build + serve. The name comes from the bootstrap plan
 * (`--base` flag > `KB_SERVER_BASE_NAME` env); when neither is declared, the golden
 * default slug `default` — a hardcoded constant, à la Postgres's `postgres`
 * maintenance DB, never a recorded/configurable choice. `kb-server start` never
 * requires naming a base to boot, and has no default-base *state* of its own to
 * consult: it never reads client-side state (`kb base use`'s `active-base` file) —
 * that would let an operator's shell silently change which base the daemon binds —
 * and it never reads anything `kb-server init` might have written, because `init`
 * writes nothing beyond materializing the same hardcoded `default` this function
 * already falls back to.
 *
 * Only the **directory** is guaranteed here — deliberately not the index. Whether
 * an index already exists at this base is a load-bearing signal for the caller:
 * `adoptLocalSnapshotIfProvided` and `--bootstrap-policy snapshot-only` both key
 * off "does `.kb-index.sqlite` exist" to tell a fresh volume from a warm one, and
 * eagerly creating an empty index here would make every volume look warm,
 * silently skipping snapshot adoption and defeating the snapshot-only refusal
 * gate. The self-heal to a real, empty, migrated index (the guarantee `init`
 * would have produced) happens later, in `planBootstrapTask`'s empty-base branch,
 * once those checks have already run.
 */
export async function resolveServerBaseDir(plan: BootstrapPlan): Promise<ResolvedBase> {
  const baseRef = plan.base || DEFAULT_BASE_SLUG
  const baseDir = await ensureOperationalBaseDir(baseRef)
  return { baseDir, baseRef }
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
  policy: BootstrapPolicy,
  log: (line: string) => void
): Promise<BootstrapTask | null> {
  if (existsSync(kbIndexDbPath(base.baseDir))) {
    // Under snapshot-only we serve the existing index as-is: no cloning/indexing
    // on boot (refresh stays an explicit operation — adopt a new snapshot).
    if (policy === 'snapshot-only') return null
    return await planWarmVolumeTask(base, plan, log)
  }

  if (plan.gitTargets.length > 0) {
    return {
      startMessage: `No index found; building "${base.baseRef}" from ${plan.source} (${plan.gitTargets.length} repo(s)) in the background…`,
      successMessage: 'Index build complete.',
      run: async () => {
        await runIndexedOp('init', base.baseRef, collector =>
          runKbInit({
            base: base.baseRef,
            nonInteractive: true,
            gitTargets: plan.gitTargets,
            ignorePatterns: plan.ignore,
            progressSink: log,
            collector,
          }).then(() => undefined)
        )
      },
    }
  }

  const repos = await discoverBaseRepos(base.baseDir)
  if (repos.length > 0) {
    return {
      startMessage: `No index found; scanning ${repos.length} cloned repo(s) in the background…`,
      successMessage: 'Index build complete.',
      run: async () => {
        await runIndexedOp('scan', base.baseRef, collector =>
          runScanCommand(['--base', base.baseRef], log, collector).then(() => undefined)
        )
      },
    }
  }

  // Nothing to build from — this is the base's genuinely-empty resting state, not
  // a fresh-volume-awaiting-a-snapshot state (those were already ruled out by the
  // `existsSync` check above and the snapshot-only gate before this function ran).
  // Materialize the real, empty, migrated index now, so the base is a first-class,
  // listable, queryable object rather than just a directory.
  await ensureBaseExists(base.baseRef)
  log(
    `Base "${base.baseRef}" is empty — no repos indexed yet. Add one to start archiving:
    kb-server base add-repo --base ${base.baseRef} --git <url>
  (CI/CD can instead pass --git / KB_SERVER_BASE_GIT_REPOS at start.) The server is up and will report an empty base until then.`
  )
  return null
}

/**
 * On a warm volume (index already present), reconcile the working trees so the node
 * can keep indexing:
 *   1. **Re-clone from provenance** — repos the snapshot recorded but whose working
 *      tree is missing (a serve-only snapshot, or a lost clone). Each is cloned from
 *      its `gitUrl` and reset to the built SHA so incremental reindex advances from
 *      there; a diverged/unreachable remote warns instead of failing.
 *   2. **Fold in newly-declared repos** — `--git` / env repos the base doesn't track
 *      yet (idempotent `kb init`).
 * Routine refresh of already-tracked repos is left to the reindex scheduler, not boot.
 * No-ops (fast restart) when there is nothing to hydrate or add.
 */
async function planWarmVolumeTask(
  base: ResolvedBase,
  plan: BootstrapPlan,
  log: (line: string) => void
): Promise<BootstrapTask | null> {
  const tracked = new Set((await discoverBaseRepos(base.baseDir)).map(repo => repo.slug))

  const manifest = await readSnapshotManifest(base.baseDir)
  const toHydrate = (manifest?.provenance.repos ?? []).filter(repo => !tracked.has(repo.slug))
  const hydrateSlugs = new Set(toHydrate.map(repo => repo.slug))

  const newTargets = plan.gitTargets.filter(target => {
    const slug = repoSlugFromGitUrl(target.url)
    return !tracked.has(slug) && !hydrateSlugs.has(slug)
  })

  if (toHydrate.length === 0 && newTargets.length === 0) return null

  const parts: string[] = []
  if (toHydrate.length > 0)
    parts.push(`re-cloning ${toHydrate.length} repo(s) from snapshot provenance`)
  if (newTargets.length > 0)
    parts.push(`folding in ${newTargets.length} newly-declared repo(s) from ${plan.source}`)

  return {
    startMessage: `Index present; ${parts.join(' and ')} in the background…`,
    successMessage: 'Repo sync complete.',
    run: async () => {
      for (const repo of toHydrate) await hydrateRepoFromProvenance(base.baseDir, repo, log)
      if (newTargets.length > 0) {
        await runIndexedOp('init', base.baseRef, collector =>
          runKbInit({
            base: base.baseRef,
            nonInteractive: true,
            gitTargets: newTargets,
            ignorePatterns: plan.ignore,
            progressSink: log,
            collector,
          }).then(() => undefined)
        )
      }
    },
  }
}

/**
 * Restore one repo's working tree from its snapshot provenance so a serve-only
 * snapshot can still keep indexing. Clones from the recorded `gitUrl`, then aligns
 * the clone to the built SHA when the remote's history still contains it (linear,
 * fast-forwardable). Warns — rather than fails — when the remote is unreachable or
 * its history has diverged from the snapshot, since the built index is still valid
 * to serve as-is.
 */
async function hydrateRepoFromProvenance(
  baseDir: string,
  repo: SnapshotRepoProvenance,
  log: (line: string) => void
): Promise<void> {
  const dest = path.join(baseDir, REPOS_SUBDIR, repo.slug)
  const branch = repo.gitBranch || undefined
  try {
    log(
      `   re-cloning ${repo.slug} from ${repo.gitUrl}${branch ? `@${branch}` : ''} to restore its working tree…`
    )
    await cloneRepo(repo.gitUrl, dest, branch)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(
      `⚠  cannot reach ${repo.gitUrl} to restore ${repo.slug}: ${message}. Serving the snapshot index as-is; ${repo.slug} will not refresh until the remote is reachable.`
    )
    return
  }
  if (repo.headSha) {
    if (await isAncestorOfHead(dest, repo.headSha)) {
      await resetToSha(dest, repo.headSha)
    } else {
      log(
        `⚠  snapshot may be stale or corrupted for ${repo.slug}: the built commit ${repo.headSha.slice(0, 12)} is not in ${repo.gitBranch}'s history on ${repo.gitUrl} (force-push or diverged history?). Re-export from the builder to resync.`
      )
    }
  }
}

/**
 * Adopt a local snapshot already present on disk (a mounted volume or an
 * unpacked artifact) before the server decides its bootstrap plan, so a serving
 * worker can start straight from prepared state without a separate `import`
 * step. The snapshot is read from the local filesystem only — the server never
 * downloads it. No-ops when `--from` / `KB_SERVER_SNAPSHOT` is unset, and skips
 * (idempotent restart) when the base already carries an index. A malformed,
 * incompatible, or corrupt snapshot throws here and fails startup loudly, before
 * the server binds — an observable misconfiguration rather than a silent build.
 */
async function adoptLocalSnapshotIfProvided(
  args: string[],
  base: ResolvedBase,
  out: ServerLogger
): Promise<void> {
  const source = resolveSnapshotSource(args)
  if (!source) return
  if (existsSync(kbIndexDbPath(base.baseDir))) {
    out.log(
      `   base "${base.baseRef}" already has an index; ignoring --from ${source} (wipe the volume to re-adopt).`
    )
    return
  }
  out.log(`   adopting local snapshot from ${source} …`)
  const { adoptSnapshot } = await import('./snapshot-cli.js')
  const manifest = await adoptSnapshot({
    from: path.resolve(source),
    baseDir: base.baseDir,
    force: false,
    verify: true,
  })
  const producer = manifest.producer.toolVersion
    ? `${manifest.producer.tool}@${manifest.producer.toolVersion}`
    : manifest.producer.tool
  out.log(
    `   adopted snapshot for base "${base.baseRef}" (built by ${producer}, index schema ${manifest.compat.indexSchema}, ${manifest.provenance.repos.length} repo(s)).`
  )
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
 * `kb-server start [--base <name>] [--port <n>] [--with-mcp]
 *                  [--git <url[#branch]>]… [--branch <name>]`
 */
/**
 * `KB_BASE` / `KB_GIT_REPOS` are the **client's** env vars (the base a `kb`
 * invocation targets; unused by the client for repos at all) — the server only
 * ever reads `KB_SERVER_BASE_NAME` / `KB_SERVER_BASE_GIT_REPOS`. On a same-machine
 * install it is easy to export the client-scoped name and expect it to steer the
 * daemon too, so warn loudly rather than silently booting the wrong base.
 */
const CLIENT_SCOPED_BASE_ENV: ReadonlyArray<{
  client: string
  server: string
  flag: string
  action: string
}> = [
  {
    client: KB_ENV.BASE,
    server: 'KB_SERVER_BASE_NAME',
    flag: '--base',
    action: 'steer which base this server boots',
  },
  {
    client: KB_ENV.GIT_REPOS,
    server: 'KB_SERVER_BASE_GIT_REPOS',
    flag: '--git',
    action: 'declare repos for this server to build',
  },
]

/**
 * Pure — returns the warning lines rather than printing them, so both the
 * foreground boot path (`runServerCommand`) and `start --daemon`'s parent
 * process (the interactive shell the operator actually sees before it
 * detaches) can surface the same check. A background daemon's own stderr
 * still goes to `kb-server.err.log`, which an operator watching only the
 * foreground `-d` output would otherwise never see.
 */
export function clientScopedBaseEnvWarnings(): string[] {
  return CLIENT_SCOPED_BASE_ENV.filter(
    ({ client, server }) => process.env[client]?.trim() && !process.env[server]?.trim()
  ).map(
    ({ client, server, flag, action }) =>
      `⚠  ${client} is set but is the client's variable — kb-server reads ${server} instead. ` +
      `Set that (or ${flag}) to ${action}.`
  )
}

function warnOnClientScopedBaseEnv(out: ServerLogger): void {
  for (const warning of clientScopedBaseEnvWarnings()) out.error(warning)
}

export async function runServerCommand(
  args: string[],
  out: ServerLogger,
  config: KbConfig
): Promise<void> {
  const enableMcp = args.includes('--with-mcp')
  const portArg = readOptionalCliValue(args, '--port')
  const port = portArg
    ? Number.parseInt(portArg, 10)
    : Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT
  if (Number.isNaN(port) || port <= 0) {
    throw new Error('--port must be a positive integer')
  }

  warnOnClientScopedBaseEnv(out)

  // Infer + announce LLM provider once at server boot.
  const inferred = await persistInferredLLMProvider({ config })
  const resolvedConfig = inferred.config
  if (inferred.notice) {
    out.log(inferred.notice)
  }

  const plan = await resolveBootstrapPlan(args)
  const base = await resolveServerBaseDir(plan)

  // Pre-warm the golden `default` base even when this process boots on a
  // different one, so `service-registry.ts`'s per-request self-heal — a
  // synchronous mkdir + sqlite migration — rarely has to run inline in a
  // request's hot path. `default` always exists once boot completes.
  if (base.baseRef !== DEFAULT_BASE_SLUG) {
    await ensureBaseExists(DEFAULT_BASE_SLUG)
  }

  // Bring in locally-supplied prepared state (mounted volume / unpacked artifact)
  // before planning bootstrap, so `start --from <dir>` serves it without building.
  await adoptLocalSnapshotIfProvided(args, base, out)

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
  const policy = resolveBootstrapPolicy(args)
  let bootstrapTask: BootstrapTask | null = null
  if (policy === 'snapshot-only' && !existsSync(kbIndexDbPath(base.baseDir))) {
    // Serve-from-snapshot with nothing to serve: refuse to build and make the
    // missing state observable in /healthz and /v1 responses (503).
    const message =
      'no snapshot available: --bootstrap-policy snapshot-only is set but no index was found. ' +
      'Supply one with `kb-server start --from <dir>` or `kb-server import`, mount a prepared volume, ' +
      'or use --bootstrap-policy auto to build.'
    bootstrapState.error = message
    recordBootstrapProgress(`⚠  ${message}`)
  } else {
    bootstrapTask = await planBootstrapTask(base, plan, policy, line =>
      recordBootstrapProgress(line)
    )
    if (bootstrapTask) bootstrapState.indexing = true
  }

  const service = createKbService({
    baseDir: base.baseDir,
    config: resolvedConfig,
    bootstrapState,
    chatStream: streamChatTurn,
  })
  // One process can serve any already-built base under ~/.kb/sessions, selected
  // per request via X-KB-Base (the default base keeps its bootstrap lifecycle).
  const registry = createKbServiceRegistry({
    defaultService: service,
    config: resolvedConfig,
    chatStream: streamChatTurn,
  })
  const apiKeys = readApiKeys()
  if (apiKeys.length === 0) {
    out.error('⚠  KB_SERVER_API_KEY is not set — /v1 and /mcp are UNAUTHENTICATED.')
    log.warn('no api key configured — /v1 and /mcp are unauthenticated')
  }
  const allowedOrigins = readAllowedOrigins(args)
  if (allowedOrigins.includes('*')) {
    out.error('⚠  CORS allows ANY origin (--allow-origin "*") — any website can call this server.')
    log.warn('cors allows any origin')
  }

  const intervalMs = parseDuration(process.env.KB_REINDEX_INTERVAL)
  if (intervalMs === undefined) {
    throw new Error(`Invalid KB_REINDEX_INTERVAL: ${process.env.KB_REINDEX_INTERVAL}`)
  }
  let scheduler = {
    stop() {},
    isRunning: () => false,
  }
  const startScheduler = (): void => {
    // Under snapshot-only, refresh is explicit (adopt a new snapshot): never arm
    // the periodic reindex, which would otherwise fail on a serve-only base that
    // has no cloned working trees to pull.
    if (policy === 'snapshot-only') {
      out.log(
        '   periodic reindex disabled (--bootstrap-policy snapshot-only); refresh by adopting a new snapshot.'
      )
      return
    }
    scheduler = startReindexScheduler({
      intervalMs,
      runReindex: async onProgress => {
        if (bootstrapState.indexing) {
          onProgress?.('skipped: bootstrap indexing still in progress')
          return undefined
        }
        const base = service.health().base
        const collector = new RunCollector('scan', { base })
        const reporter = new ReportWriter(defaultLogsDir())
        try {
          const summary = await service.reindex(onProgress, collector)
          const report = collector.finish('success', undefined, base)
          await reporter.append(report)
          log.info('reindex complete', { base, summary, ...costLogFields(report) })
          return summary
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const report = collector.finish('error', message, base)
          await reporter.append(report)
          log.error('reindex error', { base, error: message, ...costLogFields(report) })
          throw error
        }
      },
      onLog: line => {
        out.error(line)
        log.info(line)
      },
    })
  }

  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET?.trim()
  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim()
  const slack =
    slackSigningSecret && slackBotToken
      ? { signingSecret: slackSigningSecret, botToken: slackBotToken }
      : undefined
  if (slackSigningSecret && !slackBotToken) {
    out.error(
      '⚠  SLACK_SIGNING_SECRET is set but SLACK_BOT_TOKEN is missing — Slack integration disabled.'
    )
  }
  if (slackBotToken && !slackSigningSecret) {
    out.error(
      '⚠  SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is missing — Slack integration disabled.'
    )
  }

  const server = createHttpServer({
    service,
    registry,
    apiKeys,
    allowedOrigins,
    enableMcp,
    slack,
    logsDir: path.join(getKbConfigDir(), 'logs'),
    reportHost: `localhost:${port}`,
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
    allowedOrigins: allowedOrigins.length,
    reindexIntervalMs: intervalMs,
    bootstrapPolicy: policy,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  })

  // Own the pid file so `kb-server stop`/`status` can find us, however we were launched.
  writePidFile()

  out.log(`🚀 kb-server listening on :${port} (base "${path.basename(base.baseDir)}")`)
  out.log(
    `   POST /v1/query   POST /v1/chat   GET /healthz${enableMcp ? '   POST /mcp' : ''}${slack ? '   POST /slack/events' : ''}`
  )
  if (health.provider) {
    out.log(`   LLM: ${health.provider}${health.model ? ` (${health.model})` : ''}`)
  } else {
    out.log('   LLM: none configured (set GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)')
  }

  if (bootstrapTask) {
    bootstrapState.progressLine = bootstrapTask.startMessage
    out.log(bootstrapTask.startMessage)
    void (async () => {
      try {
        await bootstrapTask.run()
        out.log(bootstrapTask.successMessage)
        startScheduler()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        bootstrapState.error = message
        out.error(`⚠  Background bootstrap failed: ${message}`)
        log.error('background bootstrap failed', {
          error: message,
          base: path.basename(base.baseDir),
        })
      } finally {
        bootstrapState.indexing = false
        settleBootstrap()
      }
    })()
  } else {
    settleBootstrap()
    startScheduler()
  }

  await waitForShutdown(async () => {
    scheduler.stop()
    removePidFile()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await registry.closeAll()
    await service.close()
  })
}

const SERVER_USAGE = `Usage: kb-server <command>

Commands:
  start [-d|--daemon] [--base <name>] [--port <n>] [--with-mcp] [--git <url>]…
        [--from <dir>] [--bootstrap-policy auto|snapshot-only]
        Run the KB HTTP/MCP daemon (default command). Foreground by default;
        -d/--daemon backgrounds it (pid in ~/.kb/run, logs in ~/.kb/logs).
        --from <dir> adopts a local snapshot already on disk (mounted volume /
        unpacked artifact) before serving — pair with --bootstrap-policy
        snapshot-only for a serving worker that never builds.
  stop          Stop the running kb-server (SIGTERM, then SIGKILL).
  restart       Stop then start -d.
  status        Report whether kb-server is running (pid + /healthz).
  init          Bootstrap KB_HOME and materialize the "default" base (initdb-style;
                takes no flags — start alone self-heals to the same state).
  base <list | create | add-repo | delete> --base <name> [--git <url>…] [--yes]
        Operator base management. \`create\`/\`add-repo\` build or extend a base from
        \`--git\` repos; \`list\` shows initialized bases; \`delete\` removes one base and
        all its data (prompts unless --yes). The target base is always the explicit
        --base flag. Run \`kb-server base --help\` for details.
  service <install|uninstall|status> [--no-start]
        Register/manage kb-server as a launchd (macOS) / systemd --user (Linux)
        service that starts on login. (install is an alias for service install.)
  scan [--base <name>] [--from <dir>] [--out <dir>] [--no-verify]
       [--no-repos] [--json]
        One-shot reindex for scheduled batch jobs: adopt(optional) → scan →
        export(optional), then exit. No HTTP listener, no reindex scheduler, no
        curl. --from/--out are LOCAL paths only (object-store transport is the
        deployment's job). Batch defaults: --from always replaces an existing
        index; --out always overwrites (no --force). --json emits
        { ok:true|false, … } on stdout (failure still exits non-zero).
  export [--base <name>] --out <dir> [--no-repos] [--force]
        Snapshot a built base into a portable snapshot directory (repos + all
        settings by default; --no-repos for a small, frozen serve-only artifact)
  import --from <dir> [--base <name>] [--force] [--no-verify]
        Restore a snapshot into a base for a later start
  refresh --base <name> --out <dir> [--from <dir>] [--repos "<url>[#branch] …"]
          [--branch <b>] [--no-repos] [--timeout <ms>] [--json]
        Build a fresh snapshot dir for a builder run: adopt+rehydrate+rescan
        (warm, --from given) or clone fresh (cold, --repos only), then export
        to --out. Manages its own throwaway bootstrap child (spawn, health-wait,
        kill) — no HTTP listener stays up after. --from/--out/--repos are LOCAL
        paths / plain url[#branch] values only (object-store transport is the
        deployment's job, same as scan/export/import).
  uninstall [--purge] [--yes]
        Remove the release-installed kb-server binary/runtime; --purge deletes ~/.kb server data

Global flags:
  --version, -V   Print kb-server version and exit (does not start the daemon)
  --help, -h      Show this help
`

/** Standalone `kb-server` binary entry. */
export async function runServerMain(argv: string[]): Promise<void> {
  const out: ServerLogger = {
    log: message => console.log(message),
    error: message => console.error(message),
  }

  // Before config / listen: smoke checks and `kb-server --version` must not start the daemon.
  if (isVersionArg(argv)) {
    out.log(`kb-server v${resolveServerVersion()}`)
    return
  }

  const command = argv[0] ?? 'start'
  if (command === '--help' || command === '-h' || command === 'help') {
    out.log(SERVER_USAGE.trim())
    return
  }

  const { readKbConfig } = await import('@kb/core/config/kb-config.js')
  const config = await readKbConfig()
  const rest = argv.slice(1)

  switch (command) {
    case 'start':
      if (rest.includes('--daemon') || rest.includes('-d')) {
        await runServerStartDaemon(rest, out)
        return
      }
      await runServerCommand(rest, out, config)
      return
    case 'stop':
      await runServerStop(out, rest)
      return
    case 'status':
      await runServerStatus(rest, out)
      return
    case 'restart':
      await runServerRestart(rest, out)
      return
    case 'init': {
      const { runServerInit } = await import('./init-cli.js')
      await runServerInit(out)
      return
    }
    case 'service': {
      const { runServiceCommand } = await import('./service-cli.js')
      await runServiceCommand(rest, out)
      return
    }
    case 'install': {
      // Back-compat alias for `service install`.
      const { runServiceCommand } = await import('./service-cli.js')
      await runServiceCommand(['install', ...rest], out)
      return
    }
    case 'uninstall':
      await runServerUninstallCommand(rest, out)
      return
    case 'scan': {
      const { runServerScanCommand } = await import('./scan-cli.js')
      await runServerScanCommand(rest, out)
      return
    }
    case 'export': {
      const { runExportCommand } = await import('./snapshot-cli.js')
      await runExportCommand(rest, out)
      return
    }
    case 'import': {
      const { runImportCommand } = await import('./snapshot-cli.js')
      await runImportCommand(rest, out)
      return
    }
    case 'refresh': {
      const { runServerRefreshCommand } = await import('./refresh-cli.js')
      await runServerRefreshCommand(rest, out)
      return
    }
    case 'base': {
      const { runServerBaseCommand } = await import('./base-cli.js')
      await runServerBaseCommand(rest, out)
      return
    }
    default:
      if (command.startsWith('-')) {
        await runServerCommand(argv, out, config)
        return
      }
      throw new Error(`Unknown kb-server command: ${command}\n\n${SERVER_USAGE}`)
  }
}
