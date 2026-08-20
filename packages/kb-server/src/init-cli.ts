/**
 * `kb-server init` — the server's `initdb`.
 *
 * Bootstraps `KB_HOME` (run/logs/state dirs) and unconditionally materializes the
 * reserved `default` base: a real directory with an empty, fully-migrated
 * `.kb-index.sqlite`, the way `initdb` creates Postgres's `postgres` database before
 * anything connects. Takes no flags and records no configuration — `default` is a
 * hardcoded constant, not a choice. `kb-server start` falls back to the same constant
 * when no `--base` / `KB_SERVER_BASE_NAME` is given, so a same-machine `kb-server init`
 * + `kb-server start` + `kb` needs no configuration on either side.
 *
 * `init` is a convenience, not a prerequisite: because the fallback is a hardcoded
 * constant rather than recorded state, `kb-server start` alone — on a totally fresh
 * `KB_HOME` that never ran `init` — self-heals into exactly the same base. `init` only
 * front-loads the materialization and prints onboarding instructions.
 *
 * Idempotent: re-running reports the existing base instead of recreating it. This is
 * the first-run entry point for someone who installed the binary from a tarball and
 * has no `package.json` / repo scripts.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getKbConfigDir, readKbConfig } from '@kb/core/config/kb-config.js'
import { DEFAULT_BASE_SLUG, ensureBaseExists } from '@kb/core/storage/base-selection.js'
import { kbIndexDbPath } from '@kb/core/tools/kb-index-path.js'
import { logDir, runDir } from './daemon-cli.js'
import type { ServerLogger } from './server-cli.js'

export async function runServerInit(out: ServerLogger): Promise<void> {
  const home = getKbConfigDir()
  const dirs = [runDir(), logDir(), path.join(home, 'state')]
  for (const dir of dirs) await mkdir(dir, { recursive: true })

  await readKbConfig()

  const { baseDir, created } = await ensureBaseExists(DEFAULT_BASE_SLUG)

  out.log(`✓ KB_HOME ready at ${home}`)
  out.log('  run/, logs/, state/')
  out.log(
    created
      ? `✓ base "${DEFAULT_BASE_SLUG}" created — empty, no repos indexed yet`
      : `✓ base "${DEFAULT_BASE_SLUG}" already exists`
  )
  out.log(`  ${kbIndexDbPath(baseDir)}`)
  out.log('')

  const hasApiKey = (process.env.KB_SERVER_API_KEY ?? '').trim().length > 0

  if (!hasApiKey) {
    out.log('Next steps:')
    out.log('  1. Set a bearer token so /v1 and /mcp are authenticated:')
    out.log('       export KB_SERVER_API_KEY=<a-strong-random-token>')
    out.log('  2. Set an LLM provider key (one of GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)')
    out.log(`  3. Add repos to "${DEFAULT_BASE_SLUG}" (or leave it empty and add them later),`)
    out.log('     or create a named base instead:')
    out.log(`       kb-server base add-repo --base ${DEFAULT_BASE_SLUG} --git <url>`)
    out.log('  4. Run it:')
    out.log('       kb-server service install     # launchd/systemd, starts on login')
    out.log('       kb-server start -d            # or a one-off background daemon')
  } else {
    out.log('Next steps:')
    out.log(`  • kb-server base add-repo --base ${DEFAULT_BASE_SLUG} --git <url>`)
    out.log('  • kb-server service install     # launchd/systemd, starts on login')
    out.log('  • kb-server start -d            # or a one-off background daemon')
  }
}
