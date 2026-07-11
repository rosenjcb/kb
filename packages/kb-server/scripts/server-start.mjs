/**
 * Local `pnpm run server:start`: free PORT (stop docker or local listener), then
 * boot `kb-server start --with-mcp` via tsx from the repo root.
 */
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(scriptsDir, '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const port = process.env.PORT || '38117'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts })
}

function pidsOnPort() {
  const list = run('lsof', ['-ti', `:${port}`])
  if (list.status !== 0 && list.status !== 1) return []
  return (list.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function freePort() {
  const stopScript = path.join(scriptsDir, 'kb-service-stop.mjs')
  const stop = run(process.execPath, [stopScript], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if ((stop.status ?? 1) !== 0) {
    console.error(`▶ kb-service-stop exited ${stop.status}`)
  }

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pids = pidsOnPort()
    if (pids.length === 0) return
    console.log(`▶ waiting for :${port} to free (still: ${pids.join(', ')})`)
    for (const pid of pids) {
      run('kill', ['-KILL', pid])
    }
    sleepSync(150)
  }

  const leftover = pidsOnPort()
  if (leftover.length > 0) {
    console.error(`▶ :${port} still held by ${leftover.join(', ')} — aborting start`)
    process.exit(1)
  }
}

freePort()

const entry = path.join(pkgRoot, 'src', 'index.ts')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
const child = spawn(tsxBin, [entry, 'start', '--with-mcp', ...process.argv.slice(2)], {
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
  console.error(`▶ failed to start kb-server: ${err.message}`)
  process.exit(1)
})
