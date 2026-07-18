/**
 * `kb-server scan` — the one-shot, run-to-completion reindex.
 *
 * A scheduled batch runner (Cloud Run Job + Cloud Scheduler, an ECS scheduled
 * task, a Kubernetes CronJob, a plain cron box, …) wants a single process that
 * does *adopt a local store → scan once → write the refreshed store → exit* and
 * nothing else — no HTTP listener, no `/healthz` polling, no reindex scheduler,
 * no `curl POST /v1/admin/scan`. This command is that process. It is almost pure
 * composition of pieces that already ship: `adoptSnapshot` (the `import` path) →
 * `runScanCommand` (the same `git pull` + hash-diffed incremental reindex the
 * client's `kb scan` runs) → `runExportCommand` (the `export` path).
 *
 * With it, a scheduled reindex on ANY cloud is three shell lines:
 *
 *   <object-store> cp <remote>/snap  /snap    # gsutil / aws s3 / az — deploy's job
 *   kb-server scan --from /snap --out /out --base acme
 *   <object-store> cp /out           <remote> # deploy's job
 *
 * ## Cloud-agnostic guardrail (non-negotiable)
 *
 * `--from` / `--out` accept LOCAL paths only. This command must never learn
 * about `gs://`, `s3://`, `az://`, bucket clients, or credentials — object-store
 * transport stays 100% the deployment system's job, exactly the existing
 * snapshot philosophy (`packages/kb-server/README.md`). A URI-scheme value is
 * rejected loudly with a pointer to stage the bytes locally first, so the binary
 * stays portable across GCP / AWS / Azure / bare metal.
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import {
  ensureOperationalBaseDir,
  readOptionalCliValue,
  resolveEffectiveBaseDir,
} from '@kb/core/storage/base-selection.js'
import { computeFileDigest } from '@kb/core/storage/snapshot.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import type { ServerLogger } from './server-cli.js'
import { adoptSnapshot, formatSnapshotProducer, runExportCommand } from './snapshot-cli.js'

/** Machine-readable summary emitted on `--json` for CI/schedulers to log or alert on. */
export type ScanRunSummary =
  | {
      ok: true
      /** The base that was reindexed. */
      base: string
      /** Whether a snapshot was adopted from `--from` before scanning. */
      adopted: boolean
      /** The local `--from` snapshot dir, when one was adopted. */
      from: string | null
      /** Number of tracked repos the scan pulled + hash-diffed. */
      repos: number
      /** Whether the refreshed snapshot was exported to `--out`. */
      exported: boolean
      /** The local `--out` snapshot dir, when one was written. */
      out: string | null
      /** sha256 of the refreshed on-disk index (`.kb-index.sqlite`) after the scan. */
      indexDigest: string
    }
  | {
      ok: false
      /** The base that was targeted, when resolution got that far. */
      base: string | null
      /** Failure message (also on stderr / thrown for non-zero exit). */
      error: string
    }

/**
 * Reject object-store URIs (or any `scheme://` value) for `--from` / `--out`.
 * Staging the bytes to/from a bucket is the deployment system's job — the binary
 * only ever touches local paths (the cloud-agnostic guardrail above).
 */
function assertLocalPath(flag: string, value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const hint =
      "stage the bytes locally first (e.g. 'gsutil cp gs://… /snap' or 'aws s3 cp s3://… /snap') and pass the local dir."
    throw new Error(
      `${flag} accepts a LOCAL path only, not "${value}". kb-server never fetches from object storage; ${hint}`
    )
  }
}

/**
 * Fail-fast: `--out` emptiness / `--force` must be checked *before* adopt + scan,
 * not only inside `runExportCommand` after the expensive reindex has already run.
 */
async function assertOutReady(outDir: string, force: boolean): Promise<void> {
  const resolved = path.resolve(outDir)
  let existing: string[]
  try {
    existing = await readdir(resolved)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw err
  }
  if (existing.length > 0 && !force) {
    throw new Error(`Output directory ${resolved} is not empty; pass --force to overwrite.`)
  }
}

/** Pull the repo count out of `runScanCommand`'s summary line (single source of truth). */
function repoCountFromScanSummary(summary: string): number {
  const match = /^Scanned (\d+) repo\(s\)/.exec(summary)
  return match ? Number(match[1]) : 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `kb-server scan --base <name> [--from <dir>] [--out <dir>]
 *                 [--force] [--no-verify] [--no-repos] [--json]`
 *
 *   --from <dir>   adopt/restore a LOCAL snapshot into the base first (import path)
 *   --base <name>  base to scan (else the active / effective base)
 *   --out <dir>    export the refreshed snapshot to a LOCAL dir (export path)
 *   --force        clobber an existing index on adopt AND a non-empty --out on export
 *                  (two decisions, one flag — see HANDOFF.md; operators who only want
 *                  export overwrite still accept adopt-clobber)
 *   --no-verify    skip the adopted snapshot's sha256 integrity check
 *   --no-repos     export a small serve-only snapshot (drops the working trees)
 *   --json         emit a machine-readable summary on stdout (progress → stderr).
 *                  Success → `{ ok: true, … }`; failure → `{ ok: false, base, error }`
 *                  then still throw (non-zero exit). Schedulers should parse stdout
 *                  and/or the exit code.
 *
 * Runs in a single process and exits: no HTTP listener, no reindex scheduler
 * (one-shot mode has no interval to arm — equivalent to `KB_REINDEX_INTERVAL=0`),
 * no `curl`. Throws on failure so the process exits non-zero.
 */
export async function runServerScanCommand(
  args: string[],
  out: ServerLogger,
  cwd: string = process.cwd()
): Promise<void> {
  const from = readOptionalCliValue(args, '--from')
  const outDir = readOptionalCliValue(args, '--out')
  const baseArg = readOptionalCliValue(args, '--base')
  const force = args.includes('--force')
  const noVerify = args.includes('--no-verify')
  const noRepos = args.includes('--no-repos')
  const emitJson = args.includes('--json')

  // In --json mode, human progress goes to stderr so stdout carries only the
  // summary object; otherwise progress is ordinary stdout output.
  const progress = (line: string): void => {
    if (emitJson) out.error(line)
    else out.log(line)
  }

  let baseName: string | null = null

  try {
    if (from) assertLocalPath('--from', from)
    if (outDir) {
      assertLocalPath('--out', outDir)
      await assertOutReady(outDir, force)
    }

    const baseDir = baseArg
      ? await ensureOperationalBaseDir(baseArg, cwd)
      : (await resolveEffectiveBaseDir(cwd)).baseDir
    baseName = path.basename(baseDir)

    // 1. Optionally adopt a local snapshot into the base (reuses the import path).
    if (from) {
      progress(`📥 Adopting local snapshot from ${path.resolve(from)} …`)
      const manifest = await adoptSnapshot({
        from: path.resolve(from),
        baseDir,
        force,
        verify: !noVerify,
      })
      progress(
        `   restored base "${baseName}" (built by ${formatSnapshotProducer(manifest.producer)} · ` +
          `index schema ${manifest.compat.indexSchema} · ${manifest.provenance.repos.length} repo(s))`
      )
    }

    // 2. Scan once: git pull + hash-diffed incremental reindex + cross-repo relink.
    //    Pass the already-resolved absolute baseDir so adopt/scan/export always
    //    target the same base — even when the caller injects a non-process cwd and
    //    omits `--base` (resolveBaseToDir returns path-like values verbatim).
    const scanSummary = await runScanCommand(['--base', baseDir], progress)
    progress(`🔎 ${scanSummary}`)
    const repos = repoCountFromScanSummary(scanSummary)
    const indexDigest = await computeFileDigest(kbIndexDbPath(baseDir))

    // 3. Optionally export the refreshed base to a local snapshot dir (export path).
    if (outDir) {
      const exportArgs = ['--out', outDir, '--base', baseDir]
      if (force) exportArgs.push('--force')
      if (noRepos) exportArgs.push('--no-repos')
      await runExportCommand(exportArgs, { log: progress, error: out.error }, cwd)
    }

    if (emitJson) {
      const summary: ScanRunSummary = {
        ok: true,
        base: baseName,
        adopted: Boolean(from),
        from: from ? path.resolve(from) : null,
        repos,
        exported: Boolean(outDir),
        out: outDir ? path.resolve(outDir) : null,
        indexDigest,
      }
      out.log(JSON.stringify(summary))
    } else {
      progress(`✅ Reindex complete for base "${baseName}".`)
    }
  } catch (err) {
    if (emitJson) {
      const failure: ScanRunSummary = {
        ok: false,
        base: baseName,
        error: errorMessage(err),
      }
      out.log(JSON.stringify(failure))
    }
    throw err
  }
}
