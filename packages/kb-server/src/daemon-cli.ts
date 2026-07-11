/**
 * PID-file daemon lifecycle for `kb-server` — works identically for a local dev
 * checkout and a released binary (no `package.json` needed). The long-lived
 * server process (`runServerCommand`) owns the pid file: it writes it once it is
 * listening and removes it on shutdown, so `stop`/`status` work whether the
 * server was launched in the foreground, by `start --daemon`, or by the dev
 * `server:start` script.
 *
 * `start --daemon` re-spawns the current runtime detached
 * (`execPath + execArgv + argv[1]`, so the compiled launcher's `--no-warnings`
 * and any loader flags are preserved), then waits for `/healthz` before
 * reporting success.
 */

import { openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getKbConfigDir } from '@kb/core/config/kb-config.js'
import { DEFAULT_KB_SERVER_PORT } from '@kb/core/config/kb-server-port.js'
import type { ServerLogger } from './server-cli.js'

/** `${KB_HOME}/run` — pid file lives here; `${KB_HOME}/logs` — daemon stdout/stderr. */
export function runDir(): string {
  return path.join(getKbConfigDir(), 'run')
}
export function logDir(): string {
  return path.join(getKbConfigDir(), 'logs')
}
export function pidFilePath(): string {
  return path.join(runDir(), 'kb-server.pid')
}

/** Resolve the port a `start` invocation will bind, mirroring `runServerCommand`. */
export function resolveDaemonPort(args: string[]): number {
  const flagIdx = args.indexOf('--port')
  const raw = flagIdx !== -1 ? args[flagIdx + 1] : process.env.PORT
  const port = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_KB_SERVER_PORT
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = no such process; EPERM = alive but not ours (still "running").
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Read the pid file. Returns `null` when absent, unreadable, or stale (dead pid). */
export function readLivePid(): number | null {
  let raw: string
  try {
    raw = readFileSync(pidFilePath(), 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return isProcessAlive(pid) ? pid : null
}

/** Called by the long-lived server once it is listening. */
export function writePidFile(pid: number = process.pid): void {
  mkdirSync(runDir(), { recursive: true })
  writeFileSync(pidFilePath(), `${pid}\n`, 'utf8')
}

export function removePidFile(): void {
  try {
    rmSync(pidFilePath())
  } catch {
    // already gone
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** GET /healthz once; resolve the parsed body or `null` on any failure. */
async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: controller.signal })
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Strip the daemon flag so the detached child runs an ordinary foreground `start`. */
function stripDaemonFlag(args: string[]): string[] {
  return args.filter(arg => arg !== '--daemon' && arg !== '-d')
}

/**
 * `kb-server start --daemon`: spawn the server detached, wait for it to listen,
 * then return control to the shell. The child owns the pid file.
 */
export async function runServerStartDaemon(args: string[], out: ServerLogger): Promise<void> {
  const existing = readLivePid()
  if (existing !== null) {
    out.log(`kb-server already running (pid ${existing}). Use \`kb-server restart\` to reload.`)
    return
  }
  removePidFile() // clear any stale file

  mkdirSync(logDir(), { recursive: true })
  const outLog = path.join(logDir(), 'kb-server.out.log')
  const errLog = path.join(logDir(), 'kb-server.err.log')
  const outFd = openSync(outLog, 'a')
  const errFd = openSync(errLog, 'a')

  const childArgs = [...process.execArgv, process.argv[1], 'start', ...stripDaemonFlag(args)]
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: process.env,
  })
  child.unref()

  const port = resolveDaemonPort(args)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.pid && !isProcessAlive(child.pid) && readLivePid() === null) {
      out.error(`kb-server exited during startup — see ${errLog}`)
      process.exitCode = 1
      return
    }
    const health = await fetchHealth(port)
    if (health) {
      const pid = readLivePid() ?? child.pid
      const indexing = health.indexing === true
      out.log(`▶ kb-server started (pid ${pid}) on :${port}${indexing ? ' — building index…' : ''}`)
      out.log(`  logs: ${outLog}`)
      return
    }
    await sleep(250)
  }
  out.error(`kb-server did not become healthy on :${port} within 20s — check ${errLog}`)
  process.exitCode = 1
}

/** `kb-server stop`: SIGTERM the running server, escalate to SIGKILL, clear the pid file. */
export async function runServerStop(out: ServerLogger): Promise<void> {
  const pid = readLivePid()
  if (pid === null) {
    out.log('kb-server is not running.')
    removePidFile()
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    removePidFile()
    out.log('kb-server is not running.')
    return
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile()
      out.log(`▶ kb-server stopped (pid ${pid}).`)
      return
    }
    await sleep(200)
  }
  // Escalate.
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // gone between checks
  }
  removePidFile()
  out.log(`▶ kb-server force-stopped (pid ${pid}).`)
}

/** `kb-server status`: report running/stopped, with base + version when reachable. */
export async function runServerStatus(args: string[], out: ServerLogger): Promise<void> {
  const pid = readLivePid()
  if (pid === null) {
    out.log('kb-server: stopped')
    process.exitCode = 1
    return
  }
  const port = resolveDaemonPort(args)
  const health = await fetchHealth(port)
  if (!health) {
    out.log(`kb-server: running (pid ${pid}) — not yet answering /healthz on :${port}`)
    return
  }
  const version = (health.version as { server?: string } | undefined)?.server
  const base = typeof health.base === 'string' ? health.base : undefined
  const state = health.indexing === true ? 'indexing' : health.ok === true ? 'ready' : 'starting'
  out.log(
    `kb-server: running (pid ${pid}) on :${port} — ${state}` +
      `${base ? ` · base "${base}"` : ''}${version ? ` · v${version}` : ''}`
  )
}

/** `kb-server restart`: stop (if running) then start detached. */
export async function runServerRestart(args: string[], out: ServerLogger): Promise<void> {
  await runServerStop(out)
  await runServerStartDaemon(args, out)
}
