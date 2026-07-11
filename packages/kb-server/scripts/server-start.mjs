/**
 * Local `pnpm run server:start`: free PORT (stop docker or local listener), then
 * boot `kb-server start --with-mcp` via tsx as a **detached background daemon**
 * and return the shell. The server owns the pid file in ~/.kb/run, so
 * `pnpm run server:stop` / `server:status` (→ `kb-server stop`/`status`) manage it.
 * Logs stream to ~/.kb/logs/kb-server.{out,err}.log.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(scriptsDir, '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const port = process.env.PORT || '38117'
const kbHome = process.env.KB_HOME || path.join(os.homedir(), '.kb')
const logsDir = path.join(kbHome, 'logs')

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

// Detach the tsx server so it runs as a background daemon (the server writes its
// own pid file once listening). Running the foreground `start` here — not
// `start -d` — because the daemonizer's re-spawn relies on execArgv/argv[1],
// which tsx does not preserve; we do the detaching ourselves.
mkdirSync(logsDir, { recursive: true })
const outFd = openSync(path.join(logsDir, 'kb-server.out.log'), 'a')
const errFd = openSync(path.join(logsDir, 'kb-server.err.log'), 'a')

const entry = path.join(pkgRoot, 'src', 'index.ts')
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
const child = spawn(tsxBin, [entry, 'start', '--with-mcp', ...process.argv.slice(2)], {
  cwd: repoRoot,
  detached: true,
  stdio: ['ignore', outFd, errFd],
  env: process.env,
})

child.on('error', err => {
  console.error(`▶ failed to start kb-server: ${err.message}`)
  process.exit(1)
})

child.unref()
console.log(`▶ kb-server starting in the background on :${port} (pid ${child.pid})`)
console.log(`  logs:   ${path.join(logsDir, 'kb-server.out.log')}`)
console.log('  manage: pnpm run server:status | pnpm run server:stop')
process.exit(0)
