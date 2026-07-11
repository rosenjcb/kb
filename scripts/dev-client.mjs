/**
 * `pnpm run dev` — run the kb client CLI from TypeScript.
 * Loads `.env.local` when present (same idea as the old `dev:local`).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(repoRoot, 'packages', 'kb-client', 'src', 'cli', 'index.ts')
const envLocal = path.join(repoRoot, '.env.local')

const nodeArgs = []
if (existsSync(envLocal)) {
  nodeArgs.push(`--env-file=${envLocal}`)
}
nodeArgs.push('--import', 'tsx', entry, ...process.argv.slice(2))

const child = spawn(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', err => {
  console.error(`▶ failed to start kb client: ${err.message}`)
  process.exit(1)
})
