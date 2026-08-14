/**
 * `kb-server refresh` — build a fresh LOCAL snapshot dir for one base, either by
 * adopting + incrementally rescanning a previous snapshot (warm) or cloning fresh
 * from declared repos (cold, no previous snapshot). This is the one place that
 * knows how to boot a throwaway bootstrap child, wait for it to settle, and turn
 * the result into a `scan`/`export` call — logic every deploy script (GCP, Fly,
 * …) used to hand-roll in bash (spawn, poll `/healthz`, SIGTERM-then-SIGKILL,
 * timeout handling), now typed and tested once.
 *
 * ## Cloud-agnostic guardrail (non-negotiable, same as `scan`/`export`/`import`)
 *
 * `--from` / `--out` accept LOCAL paths only, and `--repos` is a plain
 * `url[#branch]` list (the existing `KB_GIT_REPOS` convention) — never a
 * `gs://`/`s3://` value. This command must never learn about object storage,
 * bucket clients, or credentials. Pulling the previous snapshot down and
 * publishing the fresh one (immutable version prefix + atomic pointer flip +
 * prune) stays the deployment script's job, exactly as today.
 *
 * With it, a builder run's per-base step collapses from ~80 lines of bash
 * (spawn + poll + kill + scan/export) to:
 *
 *   <object-store> cp <remote>/snap  /cur       # deploy's job
 *   kb-server refresh --base acme --from /cur --repos "$REPOS" --out /new --json
 *   <object-store> cp /new           <remote>   # deploy's job
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import {
  ensureOperationalBaseDir,
  readOptionalCliValue,
} from '@kb/core/storage/base-selection.js'
import { computeFileDigest } from '@kb/core/storage/snapshot.js'
import { kbIndexDbPath } from '@kb/core/tools/kb-index-path.js'
import { resolveDaemonPort } from './daemon-cli.js'
import type { ServerLogger } from './server-cli.js'
import { adoptSnapshot, runExportCommand } from './snapshot-cli.js'

/** Machine-readable summary emitted on `--json` for builder scripts to log or alert on. */
export type RefreshRunSummary =
  | {
      ok: true
      /** The base that was refreshed. */
      base: string
      /** Whether a previous snapshot was adopted (warm) or not (cold). */
      mode: 'warm' | 'cold'
      /** Number of tracked repos the scan pulled + hash-diffed (0 for cold). */
      repos: number
      /** The local `--out` snapshot dir the fresh build was written to. */
      out: string
      /** sha256 of the refreshed on-disk index (`.kb-index.sqlite`) after the build. */
      indexDigest: string
    }
  | {
      ok: false
      /** The base that was targeted, when resolution got that far. */
      base: string | null
      /** Failure message (also on stderr / thrown for non-zero exit). */
      error: string
    }

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const INITIAL_POLL_DELAY_MS = 250
const POLL_INTERVAL_MS = 1000

/** Reject object-store URIs (or any `scheme://` value) — same guardrail as `scan`. */
function assertLocalPath(flag: string, value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const hint =
      "stage the bytes locally first (e.g. 'gsutil cp gs://… /snap' or 'aws s3 cp s3://… /snap') and pass the local dir."
    throw new Error(
      `${flag} accepts a LOCAL path only, not "${value}". kb-server never talks to object storage; ${hint}`
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** GET /healthz once against the throwaway bootstrap child; null on any failure. */
async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** SIGTERM the bootstrap child, escalating to SIGKILL if it outlives a short grace period. */
async function forceKill(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(200)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function repoCountFromScanSummary(summary: string): number {
  const match = /^Scanned (\d+) repo\(s\)/.exec(summary)
  return match ? Number(match[1]) : 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Boot `kb-server start --bootstrap-policy auto` as a throwaway child so its
 * warm-volume task clones/re-clones `--repos` onto the base dir, then wait for
 * it to settle (`ok:true`, not still `indexing`) before killing it — the exact
 * spawn/poll/kill sequence every deploy script hand-rolled in bash.
 */
async function hydrateReposViaBootstrapChild(
  baseArg: string,
  repos: string,
  branch: string | undefined,
  timeoutMs: number,
  progress: (line: string) => void
): Promise<void> {
  const port = resolveDaemonPort([])
  const childArgs = [
    ...process.execArgv,
    process.argv[1],
    'start',
    '--base',
    baseArg,
    '--bootstrap-policy',
    'auto',
    '--port',
    String(port),
    ...(branch ? ['--branch', branch] : []),
  ]
  const env = { ...process.env, KB_GIT_REPOS: repos }
  // The child's own progress (init/scan cycle lines) is otherwise lost entirely — `stdio:
  // 'ignore'` would silently discard it, and a cold index of a large repo can run for a long
  // time with zero visibility (see #195). Route both of the child's streams into *this*
  // process's own stderr (fd 2) instead: it shows up live in `docker logs`/the container's own
  // log stream with no extra file to go find, and `refresh --json`'s one clean JSON object stays
  // untouched on stdout (fd 1) since progress already goes to stderr in `--json` mode (see
  // `progress()` above).
  progress('🌱 booting throwaway bootstrap child to hydrate repos from provenance …')
  const child = spawn(process.execPath, childArgs, { env, stdio: ['ignore', 2, 2] })

  let settled = false
  let bootstrapError: string | undefined
  try {
    await sleep(INITIAL_POLL_DELAY_MS)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const health = await fetchHealth(port)
      bootstrapError = typeof health?.bootstrapError === 'string' ? health.bootstrapError : undefined
      if (bootstrapError) break
      if (health?.ok === true && health?.indexing !== true) {
        settled = true
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
  } finally {
    if (child.pid) await forceKill(child.pid)
  }

  if (bootstrapError) {
    throw new Error(`bootstrap child failed while hydrating repos: ${bootstrapError}`)
  }
  if (!settled) {
    throw new Error(`repo hydration did not settle within ${timeoutMs}ms (bootstrap child timed out).`)
  }
  progress('  · repos hydrated')
}

/**
 * `kb-server refresh --base <name> --out <dir>
 *                    [--from <dir>] [--repos "<url>[#branch] …"] [--branch <b>]
 *                    [--no-repos] [--timeout <ms>] [--json]`
 *
 *   --base <name>   base to refresh (required)
 *   --out <dir>     write the fresh snapshot to this LOCAL dir (required)
 *   --from <dir>    adopt a previous LOCAL snapshot first (warm mode). Omit for
 *                   a cold build (requires --repos).
 *   --repos <list>  space-separated `url[#branch]` targets (same convention as
 *                   KB_GIT_REPOS) to hydrate onto the base. Required for a cold
 *                   build; optional (but typical) for a warm one, to fold in any
 *                   newly-declared repos alongside re-cloning existing ones.
 *   --branch <b>    default branch for any --repos entry with no inline #branch
 *   --no-repos      export a small serve-only snapshot (drops working trees)
 *   --timeout <ms>  how long to wait for the bootstrap child to settle
 *                   (default 30 minutes)
 *   --json          emit a machine-readable summary on stdout (progress → stderr)
 *
 * Never touches object storage — same cloud-agnostic guardrail as `scan`.
 */
export async function runServerRefreshCommand(
  args: string[],
  out: ServerLogger,
  cwd: string = process.cwd()
): Promise<void> {
  const from = readOptionalCliValue(args, '--from')
  const outDir = readOptionalCliValue(args, '--out')
  const baseArg = readOptionalCliValue(args, '--base')
  const repos = readOptionalCliValue(args, '--repos')
  const branch = readOptionalCliValue(args, '--branch')
  const noRepos = args.includes('--no-repos')
  const emitJson = args.includes('--json')
  const timeoutRaw = readOptionalCliValue(args, '--timeout')
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS

  const progress = (line: string): void => {
    if (emitJson) out.error(line)
    else out.log(line)
  }

  let baseName: string | null = baseArg ?? null

  try {
    if (!baseArg) throw new Error('kb-server refresh requires --base <name>')
    if (!outDir) throw new Error('kb-server refresh requires --out <dir>')
    if (from) assertLocalPath('--from', from)
    assertLocalPath('--out', outDir)
    if (!from && !repos) {
      throw new Error(
        'kb-server refresh requires --repos for a cold build (no --from snapshot to adopt).'
      )
    }

    const baseDir = await ensureOperationalBaseDir(baseArg, cwd)
    baseName = path.basename(baseDir)
    const mode: 'warm' | 'cold' = from ? 'warm' : 'cold'

    if (from) {
      progress(`📥 Adopting local snapshot from ${path.resolve(from)} …`)
      const manifest = await adoptSnapshot({
        from: path.resolve(from),
        baseDir,
        force: true,
        verify: true,
      })
      progress(
        `   restored base "${baseName}" (${manifest.provenance.repos.length} repo(s) in provenance)`
      )
    }

    if (repos) {
      await hydrateReposViaBootstrapChild(baseArg, repos, branch, timeoutMs, progress)
    }

    let repoCount = 0
    if (mode === 'warm') {
      // Repos are on disk now (adopted index + hydrated clones) — pull + hash-diff
      // reindex catches new commits since the adopted snapshot was built.
      const scanSummary = await runScanCommand(['--base', baseDir], progress)
      progress(`🔎 ${scanSummary}`)
      repoCount = repoCountFromScanSummary(scanSummary)
    }

    const exportArgs = ['--out', outDir, '--base', baseDir, '--force']
    if (noRepos) exportArgs.push('--no-repos')
    await runExportCommand(exportArgs, { log: progress, error: out.error }, cwd)
    const indexDigest = await computeFileDigest(kbIndexDbPath(baseDir))

    if (emitJson) {
      const summary: RefreshRunSummary = {
        ok: true,
        base: baseName,
        mode,
        repos: repoCount,
        out: path.resolve(outDir),
        indexDigest,
      }
      out.log(JSON.stringify(summary))
    } else {
      progress(`✅ Refresh complete for base "${baseName}" (${mode}).`)
    }
  } catch (err) {
    if (emitJson) {
      const failure: RefreshRunSummary = {
        ok: false,
        base: baseName,
        error: errorMessage(err),
      }
      out.log(JSON.stringify(failure))
    }
    throw err
  }
}
