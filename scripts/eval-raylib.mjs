#!/usr/bin/env node
/** @deprecated Use `npm run eval:raylib` (wraps eval-run with default raylib upstream URL) or call eval-run directly. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const userArgs = process.argv.slice(2)
const hasRepo = userArgs.includes('--repo')
const argv = hasRepo ? userArgs : ['--repo', 'https://github.com/raysan5/raylib.git', ...userArgs]
const r = spawnSync(
  process.execPath,
  [path.join(dir, 'eval-run.mjs'), 'all', '--suite', 'raylib', ...argv],
  {
    stdio: 'inherit',
  }
)
process.exit(r.status === 0 ? 0 : r.status === null ? 1 : r.status)
