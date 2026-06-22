/**
 * Integration test runner (`pnpm run integration:test`).
 *
 * Spins up the server in Docker (docker-compose), waits for it to become
 * healthy, runs the httpyac suite (http/kb-api.http) against it, then tears the
 * container down. Exit code is the httpyac suite's result.
 *
 * Requirements: Docker + docker compose, and an LLM provider key in the
 * environment (GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY) so the
 * /v1/query and /v1/chat assertions can pass. KB_GIT_REPOS controls what gets
 * indexed on first boot (defaults to a small public repo).
 *
 * httpyac is fetched on demand via `pnpm dlx` (kept out of the repo's deps).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseUrl = process.env.KB_TEST_BASE_URL || 'http://localhost:8080'
const HEALTH_TIMEOUT_MS = 6 * 60 * 1000 // first boot clones + indexes

const env = {
  ...process.env,
  KB_BASE: process.env.KB_BASE || 'integration',
  KB_GIT_REPOS: process.env.KB_GIT_REPOS || 'https://github.com/sindresorhus/is',
  KB_SERVER_API_KEY: process.env.KB_SERVER_API_KEY || 'testkey',
  KB_REINDEX_INTERVAL: '0',
  PORT: process.env.PORT || '8080',
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env }).status ?? 1
}

function hasProviderKey() {
  return Boolean(env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY)
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  return false
}

async function main() {
  if (!hasProviderKey()) {
    console.error(
      '⚠  No LLM provider key set (GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY).'
    )
    console.error('   /v1/query and /v1/chat assertions will fail without one.')
  }

  console.log('▶ docker compose up -d --build …')
  if (run('docker', ['compose', 'up', '-d', '--build']) !== 0) {
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
    console.log('▶ running httpyac suite (pnpm dlx httpyac) …')
    exitCode = run('pnpm', [
      'dlx',
      'httpyac@6',
      'send',
      'http/kb-api.http',
      '--all',
      '--env',
      'local',
      '--output',
      'short',
    ])
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
