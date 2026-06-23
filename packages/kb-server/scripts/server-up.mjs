/**
 * Guided first-run for a self-hosted kb server (`pnpm run server:up`).
 *
 * The friendly entrypoint documented in packages/kb-server/README.md. It:
 *   1. Ensures a repo-root `.env` exists (seeds it from `.env.example` on first run and
 *      stops so you can fill in secrets — we never boot with placeholder keys).
 *   2. Sanity-checks the config (a provider key is present; the bearer key is not the
 *      insecure default; a fresh volume has repos to index) and warns, not blocks.
 *   3. Builds + starts only the `kb-server` service (the test-only `mock` profile stays
 *      off) and prints the next steps (health, logs, a sample query, stop).
 *
 * Raw `docker compose` still works (see README); this just removes the footguns for a
 * fresh KB. Pure orchestration — no app imports — so it runs against the built image.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const composeFile = path.join(pkgRoot, 'docker-compose.yml')
const envPath = path.join(repoRoot, '.env')
const envExamplePath = path.join(repoRoot, '.env.example')

const PROVIDER_KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Minimal `.env` reader: `KEY=value` lines, `#` comments and blanks ignored. */
function readEnvFile(file) {
  const env = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

/** Treat shell env as an override of `.env` (compose resolves it the same way). */
function effective(env, key) {
  const fromShell = process.env[key]
  if (fromShell !== undefined && fromShell !== '') return fromShell
  return env[key] ?? ''
}

function ensureDocker() {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    fail(
      'Docker (with the Compose plugin) is required and was not found. Install Docker Desktop / Engine, then re-run `pnpm run server:up`.'
    )
  }
}

function ensureEnvFile() {
  if (existsSync(envPath)) return
  if (!existsSync(envExamplePath)) {
    fail(`No .env and no .env.example to seed it from (looked in ${repoRoot}).`)
  }
  copyFileSync(envExamplePath, envPath)
  console.log(`▶ Created .env from .env.example → ${envPath}\n`)
  console.log('  Set these before starting the server, then re-run `pnpm run server:up`:')
  console.log('    • a provider key   — GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY)')
  console.log('    • KB_SERVER_API_KEY — a strong bearer token (not the testkey default)')
  console.log('    • KB_GIT_REPOS      — comma-separated git URLs to index on first boot')
  console.log('    • GITHUB_TOKEN      — optional, for private GitHub repos over HTTPS')
  process.exit(0)
}

function checkConfig() {
  const env = readEnvFile(envPath)
  const warnings = []

  if (!PROVIDER_KEYS.some(key => effective(env, key))) {
    fail(
      `No LLM provider key set. Put one of ${PROVIDER_KEYS.join(', ')} in ${envPath}, then re-run.`
    )
  }

  const apiKey = effective(env, 'KB_SERVER_API_KEY')
  if (!apiKey) {
    warnings.push('KB_SERVER_API_KEY is empty — /v1 and /mcp will be UNAUTHENTICATED.')
  } else if (apiKey === 'testkey') {
    warnings.push('KB_SERVER_API_KEY is still "testkey" — set a strong, unique bearer token.')
  }

  // First boot needs something to index; a warm volume (already-built index) does not.
  const hasRepos = Boolean(effective(env, 'KB_GIT_REPOS'))
  const hasManifest =
    existsSync(path.join(repoRoot, 'kb-server.json')) || existsSync(path.join(pkgRoot, 'kb-server.json'))
  if (!hasRepos && !hasManifest) {
    warnings.push(
      'No KB_GIT_REPOS and no kb-server.json — a fresh volume will start with an empty index ' +
        '(set repos, or POST /v1/reindex once the base tracks some).'
    )
  }

  for (const warning of warnings) console.log(`⚠  ${warning}`)
  if (warnings.length > 0) console.log('')
  return env
}

function composeUp() {
  console.log('▶ docker compose up -d --build kb-server …\n')
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      envPath,
      '-f',
      composeFile,
      'up',
      '-d',
      '--build',
      'kb-server',
    ],
    { stdio: 'inherit', cwd: repoRoot }
  )
  if (result.status !== 0) fail('docker compose up failed (see output above).')
}

function printNextSteps(env) {
  const port = effective(env, 'PORT') || '8080'
  const apiKey = effective(env, 'KB_SERVER_API_KEY') || 'testkey'
  const base = effective(env, 'KB_BASE') || 'demo'
  console.log('\n✓ kb-server is starting. First boot clones + indexes your repos — watch progress:')
  console.log('    pnpm run server:docker:logs')
  console.log('\n  Health (unauthenticated):')
  console.log(`    curl http://localhost:${port}/healthz`)
  console.log('\n  Query (once healthy):')
  console.log(`    curl -s http://localhost:${port}/v1/query \\`)
  console.log(`      -H "Authorization: Bearer ${apiKey}" \\`)
  console.log(`      -H 'Content-Type: application/json' \\`)
  console.log(`      -d '{"query":"how does ${base} handle auth?"}'`)
  console.log('\n  Stop:    pnpm run server:docker:stop')
  console.log(
    '  Reset:   docker compose -f packages/kb-server/docker-compose.yml down -v   # wipes the index volume'
  )
}

ensureDocker()
ensureEnvFile()
const env = checkConfig()
composeUp()
printNextSteps(env)
