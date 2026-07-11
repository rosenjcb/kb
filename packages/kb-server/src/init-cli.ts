/**
 * `kb-server init` — bootstrap KB_HOME and server config for a fresh install.
 * Idempotent: ensures the data directories exist and a default config is
 * written, then prints the next steps (set an API key, then run as a service or
 * a daemon). This is the first-run entry point for someone who installed the
 * binary from a tarball and has no `package.json` / repo scripts.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { ensureDefaultConfig, getKbConfigDir } from '@kb/core/config/kb-config.js'
import { logDir, runDir } from './daemon-cli.js'
import type { ServerLogger } from './server-cli.js'

export async function runServerInit(out: ServerLogger): Promise<void> {
  const home = getKbConfigDir()
  const dirs = [runDir(), logDir(), path.join(home, 'state')]
  for (const dir of dirs) await mkdir(dir, { recursive: true })

  await ensureDefaultConfig()

  const hasApiKey = (process.env.KB_SERVER_API_KEY ?? '').trim().length > 0

  out.log(`✓ KB_HOME ready at ${home}`)
  out.log(`  ${path.join(home, 'config.json')}, run/, logs/, state/`)
  out.log('')
  if (!hasApiKey) {
    out.log('Next steps:')
    out.log('  1. Set a bearer token so /v1 and /mcp are authenticated:')
    out.log('       export KB_SERVER_API_KEY=<a-strong-random-token>')
    out.log('  2. Set an LLM provider key (one of GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)')
    out.log('  3. Run it:')
    out.log('       kb-server service install     # launchd/systemd, starts on login')
    out.log('       kb-server start -d            # or a one-off background daemon')
  } else {
    out.log('Next steps:')
    out.log('  • kb-server service install     # launchd/systemd, starts on login')
    out.log('  • kb-server start -d            # or a one-off background daemon')
  }
}
