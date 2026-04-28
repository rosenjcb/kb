#!/usr/bin/env node
/** @deprecated Use `npm run eval:kb-proper` (wraps eval-run with default kb origin URL) or call eval-run directly. */
import { execSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const kbRoot = path.resolve(dir, '..')
let defaultRepo = 'https://github.com/rosenjcb/kb.git'
try {
  defaultRepo = execSync('git remote get-url origin', { cwd: kbRoot, encoding: 'utf8' }).trim()
} catch {
  /* keep fallback */
}
const userArgs = process.argv.slice(2)
const hasRepo = userArgs.includes('--repo')
const argv = hasRepo ? userArgs : ['--repo', defaultRepo, ...userArgs]
const r = spawnSync(
  process.execPath,
  [path.join(dir, 'eval-run.mjs'), 'all', '--suite', 'kb', ...argv],
  {
    stdio: 'inherit',
  }
)
process.exit(r.status === 0 ? 0 : r.status === null ? 1 : r.status)
