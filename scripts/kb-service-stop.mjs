/**
 * Stop a running kb server or MCP HTTP listener.
 *
 * 1. If docker compose has kb-server running → `docker compose stop …`
 * 2. Else send SIGTERM to whatever is listening on PORT (default 8080)
 *
 * Stdio MCP (`mcp start` without --http) is foreground-only; there is nothing to stop.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.PORT || '8080'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
}

function dockerServerRunning() {
  const result = run('docker', ['compose', 'ps', '--status', 'running', '-q', 'kb-server'])
  return result.status === 0 && Boolean(result.stdout?.trim())
}

function stopDocker() {
  console.log('▶ docker compose stop kb-server llm-mock …')
  const result = run('docker', ['compose', 'stop', 'kb-server', 'llm-mock'], { stdio: 'inherit' })
  return result.status ?? 1
}

function stopLocalPort() {
  const list = run('lsof', ['-ti', `:${port}`])
  const pids = (list.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (pids.length === 0) {
    console.log(`▶ no process listening on :${port}`)
    return 0
  }

  console.log(`▶ stopping process(es) on :${port}: ${pids.join(', ')}`)
  for (const pid of pids) {
    run('kill', ['-TERM', pid], { stdio: 'inherit' })
  }
  return 0
}

const mode = process.argv[2] ?? 'server'

if (dockerServerRunning()) {
  process.exit(stopDocker())
}

if (mode === 'mcp') {
  console.log('▶ no docker kb-server; checking local MCP HTTP port …')
}

process.exit(stopLocalPort())
