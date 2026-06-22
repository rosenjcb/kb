/**
 * Stop a running kb server (docker compose or local process on PORT).
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

if (dockerServerRunning()) {
  process.exit(stopDocker())
}

process.exit(stopLocalPort())
