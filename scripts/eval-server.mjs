/**
 * Eval/MOEL kb-server orchestration — start (or attach to) a live kb-server for harness runs.
 *
 * Pre-server phases (init/scan via scripts/eval-index.ts) use buildEvalOfflineEnv() to clear
 * remote connection vars. Query phases use buildKbRemoteEnv() / session.kbEnv() with
 * KB_SERVER_URL + KB_SERVER_API_KEY (or KB_EVAL_SERVER_URL when attaching).
 *
 * Multi-suite batches share one multi-base kb-server (psql/postmaster model): the parent
 * spawns once, children attach via KB_EVAL_SERVER_URL and select `eval-{suite}` per request
 * with `--base` / `X-KB-Base`. Per-base readiness uses `/healthz?base=<slug>`.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const KB_REPO = path.resolve(__dirname, '..')

const DEFAULT_SERVER_BIN = path.join(KB_REPO, 'packages/kb-server/dist/bin/kb-server.js')
const DEFAULT_HEALTH_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_LISTEN_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2000
const DEFAULT_EVAL_API_KEY = 'eval-local-key'
/** Match `@kb/core/config/kb-server-port` — standard kb-server listen port. */
export const DEFAULT_KB_SERVER_PORT = 38117

/** @returns {string} */
export function defaultEvalServerBin() {
  return process.env.KB_EVAL_SERVER_BIN
    ? path.resolve(process.env.KB_EVAL_SERVER_BIN)
    : DEFAULT_SERVER_BIN
}

/** @returns {string} */
export function defaultEvalApiKey() {
  return process.env.KB_EVAL_SERVER_API_KEY?.trim() || DEFAULT_EVAL_API_KEY
}

/**
 * Allocate an ephemeral TCP port on `host`.
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function allocateFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, host, () => {
      const addr = probe.address()
      const port = typeof addr === 'object' && addr ? addr.port : null
      probe.close(err => {
        if (err) reject(err)
        else if (!port) reject(new Error('[eval-server] could not allocate a free port'))
        else resolve(port)
      })
    })
  })
}

/**
 * Build subprocess env for offline eval indexing children (eval-index init/scan).
 * Clears remote connection vars so children index via `@kb/core` without hitting a
 * live server (avoids SQLite contention during eval capture).
 * @param {{ kbHome?: string }} [opts]
 */
export function buildEvalOfflineEnv({ kbHome } = {}) {
  const env = { ...process.env }
  env.KB_SERVER_URL = undefined
  env.KB_HOST = undefined
  env.KB_PORT = undefined
  env.KB_SERVER_API_KEY = undefined
  env.NODE_PATH = undefined
  if (kbHome) env.KB_HOME = kbHome
  else env.KB_HOME = undefined
  return env
}

/**
 * Build subprocess env for remote kb client calls (query / docs / graph after server attach).
 * @param {{ host?: string, port?: number | string, url?: string, apiKey?: string, kbHome?: string, base?: string }} opts
 */
export function buildKbRemoteEnv({
  host = '127.0.0.1',
  port,
  url,
  apiKey = defaultEvalApiKey(),
  kbHome,
  base,
} = {}) {
  const env = { ...process.env }
  env.NODE_PATH = undefined

  const resolvedUrl = url?.trim()
    ? url.trim().replace(/\/$/, '')
    : `http://${host}:${port}`

  env.KB_SERVER_URL = resolvedUrl
  env.KB_SERVER_API_KEY = apiKey
  env.KB_HOST = undefined
  env.KB_PORT = undefined

  if (base?.trim()) env.KB_BASE = base.trim()
  else env.KB_BASE = undefined

  if (kbHome) env.KB_HOME = kbHome
  else env.KB_HOME = undefined

  return env
}

/** @param {string} baseUrl @param {string} [base] */
export function healthzUrl(baseUrl, base) {
  const url = baseUrl.replace(/\/$/, '')
  if (!base?.trim()) return `${url}/healthz`
  return `${url}/healthz?base=${encodeURIComponent(base.trim())}`
}

/**
 * Poll `/healthz` until the server accepts connections.
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, base?: string }} [opts]
 */
export async function waitForServerListening(baseUrl, { timeoutMs = DEFAULT_LISTEN_TIMEOUT_MS, base } = {}) {
  const url = healthzUrl(baseUrl, base)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      // 404 unknown_base means the process is up but that slug is missing — still "listening".
      if (res.status < 500) return
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`[eval-server] kb-server did not start listening at ${url} within ${timeoutMs}ms`)
}

/**
 * Poll `/healthz` until `ok: true` and an index is present (two consecutive OK reads).
 * Pass `base` to probe a specific multi-base slug (`/healthz?base=`).
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, base?: string }} [opts]
 */
export async function waitForServerReady(baseUrl, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, base } = {}) {
  const url = healthzUrl(baseUrl, base)
  const deadline = Date.now() + timeoutMs
  let consecutiveOk = 0
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = await res.json()
        if (body?.ok === true && typeof body.indexMtime === 'string') {
          consecutiveOk += 1
          if (consecutiveOk >= 2) return body
        } else {
          consecutiveOk = 0
        }
      } else {
        consecutiveOk = 0
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      consecutiveOk = 0
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(
    `[eval-server] kb-server index not ready at ${url} (ok: true) within ${timeoutMs}ms`
  )
}

/**
 * Start kb-server for an eval session, or attach to an existing sidecar / shared multi-base parent.
 *
 * @param {{
 *   base: string,
 *   host?: string,
 *   port?: number,
 *   kbHome?: string,
 *   apiKey?: string,
 *   serverBin?: string,
 *   logPath?: string,
 *   healthTimeoutMs?: number,
 * }} opts
 */
export async function startEvalServer({
  base,
  host = '127.0.0.1',
  port,
  kbHome,
  apiKey = defaultEvalApiKey(),
  serverBin = defaultEvalServerBin(),
  logPath,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
}) {
  const attachUrl =
    process.env.KB_EVAL_SERVER_URL?.trim() || process.env.KB_EVAL_ATTACH_URL?.trim() || null

  if (attachUrl) {
    const url = attachUrl.replace(/\/$/, '')
    const attachKey = process.env.KB_SERVER_API_KEY?.trim() || apiKey
    console.error(`[eval-server] attaching to ${url} (multi-base sidecar) for base=${base}`)
    await waitForServerListening(url)
    await assertEvalServerBase(url, base)
    return createAttachedSession({ url, apiKey: attachKey, kbHome, healthTimeoutMs, base })
  }

  if (!fs.existsSync(serverBin)) {
    throw new Error(
      process.env.KB_EVAL_SERVER_BIN
        ? `Missing kb-server binary at KB_EVAL_SERVER_BIN=${serverBin} — build it first (pnpm run build).`
        : 'Missing packages/kb-server/dist/bin/kb-server.js — run: pnpm run build (or set KB_EVAL_SERVER_BIN).'
    )
  }

  // Default to an ephemeral free port. Hard-coding 38117 makes parallel
  // --all-suites children collide when --per-suite-server is used.
  // Pin with `port` or KB_EVAL_SERVER_PORT only for single-suite attach/debug.
  let resolvedPort =
    port ??
    (process.env.KB_EVAL_SERVER_PORT
      ? Number.parseInt(process.env.KB_EVAL_SERVER_PORT, 10)
      : null)

  if (resolvedPort == null) {
    resolvedPort = await allocateFreePort(host)
  }

  if (!Number.isFinite(resolvedPort) || resolvedPort <= 0) {
    throw new Error(`[eval-server] invalid port: ${resolvedPort}`)
  }

  const url = `http://${host}:${resolvedPort}`
  const args = ['start', '--base', base, '--port', String(resolvedPort)]
  const childEnv = {
    ...process.env,
    KB_SERVER_API_KEY: apiKey,
    KB_REINDEX_INTERVAL: '0',
  }
  if (kbHome) childEnv.KB_HOME = kbHome

  let logFd = null
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    logFd = fs.openSync(logPath, 'w')
  }

  console.error(`[eval-server] starting kb-server --base ${base} on ${url} (multi-base registry on)`)
  const child = spawn(process.execPath, [serverBin, ...args], {
    env: childEnv,
    stdio: ['ignore', logFd ?? 'inherit', logFd ?? 'inherit'],
    detached: false,
  })

  if (logFd != null) {
    fs.closeSync(logFd)
  }

  child.on('error', err => {
    console.error(`[eval-server] kb-server spawn error: ${err.message}`)
  })

  await waitForServerListening(url)

  if (child.exitCode != null) {
    throw new Error(
      `[eval-server] kb-server exited with code ${child.exitCode} before becoming ready ` +
        `(base=${base} url=${url}) — likely a port bind race; refusing to query a foreign server`
    )
  }

  await assertEvalServerBase(url, base)

  return {
    url,
    host,
    port: resolvedPort,
    apiKey,
    base,
    attached: false,
    child,
    healthTimeoutMs,
    kbEnv() {
      return buildKbRemoteEnv({ url, apiKey, kbHome, base })
    },
    waitReady(opts = {}) {
      return waitForServerReady(url, {
        timeoutMs: opts.timeoutMs ?? healthTimeoutMs,
        base: opts.base ?? base,
      })
    },
    async stop() {
      if (!child || child.exitCode != null) return
      await stopChild(child)
    },
  }
}

/**
 * Confirm `/healthz?base=` reports the expected session base before queries run.
 * Works for both single-base servers and shared multi-base parents.
 * @param {string} baseUrl
 * @param {string} expectedBase
 */
export async function assertEvalServerBase(baseUrl, expectedBase) {
  const url = healthzUrl(baseUrl, expectedBase)
  const res = await fetch(url)
  if (res.status === 404) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.status ? ` status=${body.status}` : ''
    } catch {
      /* ignore */
    }
    throw new Error(
      `[eval-server] unknown base "${expectedBase}" at ${url}${detail} — build the index first (kb init / scan)`
    )
  }
  if (res.status >= 500) {
    throw new Error(`[eval-server] /healthz returned ${res.status} at ${url}`)
  }
  const body = await res.json()
  const got = typeof body?.base === 'string' ? body.base : null
  if (got !== expectedBase) {
    throw new Error(
      `[eval-server] /healthz base mismatch at ${url}: expected "${expectedBase}", got ${
        got == null ? 'null' : `"${got}"`
      }`
    )
  }
}

/** @param {{ url: string, apiKey: string, kbHome?: string, healthTimeoutMs: number, base: string }} session */
function createAttachedSession({ url, apiKey, kbHome, healthTimeoutMs, base }) {
  return {
    url,
    host: null,
    port: null,
    apiKey,
    base,
    attached: true,
    child: null,
    healthTimeoutMs,
    kbEnv() {
      return buildKbRemoteEnv({ url, apiKey, kbHome, base })
    },
    waitReady(opts = {}) {
      return waitForServerReady(url, {
        timeoutMs: opts.timeoutMs ?? healthTimeoutMs,
        base: opts.base ?? base,
      })
    },
    async stop() {},
  }
}

/** @param {import('node:child_process').ChildProcess} child */
async function stopChild(child) {
  if (child.exitCode != null) return
  const pid = child.pid
  if (!pid) return

  child.kill('SIGTERM')
  const exited = await waitForExit(child, 10_000)
  if (exited) return

  console.error(`[eval-server] kb-server (pid ${pid}) did not exit after SIGTERM — sending SIGKILL`)
  child.kill('SIGKILL')
  await waitForExit(child, 5_000)
}

/** @param {import('node:child_process').ChildProcess} child @param {number} timeoutMs */
function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
