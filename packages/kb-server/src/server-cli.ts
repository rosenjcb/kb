/**
 * CLI dispatch for `kb-server start`.
 *
 * Builds the shared `KbService` once and keeps the process alive until a
 * shutdown signal.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { type KbConfig, getKbConfigDir } from '@kb/core/config/kb-config.js'
import { DEFAULT_KB_SERVER_PORT } from '@kb/core/config/kb-server-port.js'
import { cloneRepo, isAncestorOfHead, resetToSha } from '@kb/core/ops/git-sync.js'
import { runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import { createKbService } from '@kb/core/service/kb-service.js'
import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import { CLI_ERROR_NO_KB_BASE } from '@kb/core/config/cli-prerequisites.js'
import {
  DEFAULT_BASE_SLUG,
  ensureOperationalBaseDir,
  readOptionalCliValue,
  resolveEffectiveBaseDir,
} from '@kb/core/storage/base-selection.js'
import { REPOS_SUBDIR, repoSlugFromGitUrl } from '@kb/core/storage/repo-slug.js'
import { type SnapshotRepoProvenance, readSnapshotManifest } from '@kb/core/storage/snapshot.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
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
import { createKbServiceRegistry } from './service-registry.js'
import { log } from './logger.js'
import { parseDuration, startReindexScheduler } from './reindex-scheduler.js'
import {
  type BootstrapPlan,
  type BootstrapPolicy,
  resolveBootstrapPlan,
  resolveBootstrapPolicy,
  resolveSnapshotSource,
} from './server-bootstrap.js'
import { runServerUninstallCommand } from './uninstall-cli.js'
import { resolveServerVersion } from './version.js'

export interface ServerLogger {
  log(message: string): void
  error(message: string): void
}

const DEFAULT_PORT = DEFAULT_KB_SERVER_PORT

function isVersionArg(argv: string[]): boolean {
  return (
    argv.includes('--version') ||
    argv.includes('-V') ||
    argv[0] === 'version' ||
    argv[0] === '-v'
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
    for (const origin of raw.split(',').map(o => o.trim()).filter(o => o.length > 0)) {
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
 * (`--base` flag > `KB_SERVER_BASE_NAME` / `KB_BASE` env); when none is
 * declared, prefer a base the operator already selected locally (`kb base use`),
 * and otherwise bind the golden default slug `base` — the cluster's well-known
 * default, à la Postgres's `postgres` maintenance DB. `kb-server start` never
 * requires naming a base to boot.
 */
export async function resolveServerBaseDir(plan: BootstrapPlan): Promise<ResolvedBase> {
  if (plan.base) {
    return { baseDir: await ensureOperationalBaseDir(plan.base), baseRef: plan.base }
  }
  try {
    const resolved = await resolveEffectiveBaseDir()
    return { baseDir: resolved.baseDir, baseRef: resolved.baseName }
  } catch (error) {
    if (error instanceof Error && error.message === CLI_ERROR_NO_KB_BASE) {
      return {
        baseDir: await ensureOperationalBaseDir(DEFAULT_BASE_SLUG),
        baseRef: DEFAULT_BASE_SLUG,
      }
    }
    throw error
  }
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

  const repos = await discoverBaseRepos(base.baseDir)
  if (repos.length > 0) {
    return {
      startMessage: `No index found; scanning ${repos.length} cloned repo(s) in the background…`,
      successMessage: 'Index build complete.',
      run: async () => {
        await runScanCommand(['--base', base.baseRef], log)
      },
    }
  }

  log(
    '⚠  No index and no repos configured. Declare repos via --git or KB_SERVER_BASE_GIT_REPOS ' +
      '(or KB_GIT_REPOS) and restart to build the index.'
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
        await runKbInit({
          base: base.baseRef,
          nonInteractive: true,
          gitTargets: newTargets,
          ignorePatterns: plan.ignore,
          progressSink: log,
        })
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

  const plan = await resolveBootstrapPlan(args)
  const base = await resolveServerBaseDir(plan)

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
    config,
    bootstrapState,
    chatStream: streamChatTurn,
  })
  // One process can serve any already-built base under ~/.kb/sessions, selected
  // per request via X-KB-Base (the default base keeps its bootstrap lifecycle).
  const registry = createKbServiceRegistry({
    defaultService: service,
    config,
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
        return await service.reindex(onProgress)
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
  init          Bootstrap KB_HOME and server config, then print next steps.
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

  const { ensureDefaultConfig } = await import('@kb/core/config/kb-config.js')
  const config = await ensureDefaultConfig()
  const rest = command === 'start' ? argv.slice(1) : argv.slice(1)

  switch (command) {
    case 'start':
      if (rest.includes('--daemon') || rest.includes('-d')) {
        await runServerStartDaemon(rest, out)
        return
      }
      await runServerCommand(rest, out, config)
      return
    case 'stop':
      await runServerStop(out)
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
    default:
      if (command.startsWith('-')) {
        await runServerCommand(argv, out, config)
        return
      }
      throw new Error(`Unknown kb-server command: ${command}\n\n${SERVER_USAGE}`)
  }
}
