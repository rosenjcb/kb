/**
 * Integration test runner (`pnpm run integration:test`).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const baseUrl = process.env.KB_TEST_BASE_URL || 'http://localhost:8080'
const HEALTH_TIMEOUT_MS = 6 * 60 * 1000

const env = {
  ...process.env,
  KB_BASE: process.env.KB_BASE || 'integration',
  KB_GIT_REPOS: process.env.KB_GIT_REPOS || 'https://github.com/sindresorhus/is',
  KB_SERVER_API_KEY: process.env.KB_SERVER_API_KEY || 'testkey',
  KB_REINDEX_INTERVAL: '0',
  PORT: process.env.PORT || '8080',
  GEMINI_API_KEY: 'integration-mock-key',
  GEMINI_API_BASE_URL: 'http://llm-mock:8080',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
}

function run(cmd, args, cwd = pkgRoot) {
  return spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd, env }).status ?? 1
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let consecutiveOk = 0
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`)
      if (res.ok) {
        const body = await res.json()
        if (body?.ok === true && typeof body.indexMtime === 'string') {
          consecutiveOk += 1
          if (consecutiveOk >= 2) return true
        } else {
          consecutiveOk = 0
        }
      } else {
        consecutiveOk = 0
      }
    } catch {
      consecutiveOk = 0
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return false
}

async function main() {
  console.log('▶ LLM: WireMock sidecar (http://llm-mock:8080) — no real API calls')
  console.log('▶ docker compose down -v (clean slate) …')
  run('docker', ['compose', 'down', '-v'])
  console.log('▶ docker compose up -d --build --wait …')
  if (run('docker', ['compose', 'up', '-d', '--build', '--wait']) !== 0) {
    console.error('❌ docker compose up failed')
    process.exit(1)
  }

  let exitCode = 1
  try {
    console.log(`▶ waiting for ${baseUrl}/healthz (first boot builds the index) …`)
    if (!(await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS))) {
      console.error('❌ server did not become healthy in time')
      run('docker', ['compose', 'logs', '--no-color', '--tail', '80'])
      throw new Error('unhealthy')
    }
    console.log('▶ running httpyac suite (pnpm exec httpyac) …')
    exitCode = run(
      'pnpm',
      [
        'exec',
        'httpyac',
        'send',
        'packages/kb-server/http/server.http',
        '--all',
        '--env',
        'local',
        '--output',
        'short',
      ],
      repoRoot
    )
  } catch {
    exitCode = 1
  } finally {
    console.log('▶ docker compose down -v …')
    run('docker', ['compose', 'down', '-v'])
  }

  process.exit(exitCode)
}

main().catch(error => {
  console.error(`❌ ${error.message}`)
  run('docker', ['compose', 'down', '-v'])
  process.exit(1)
})
