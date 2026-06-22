/**
 * Changeset entrypoint (`pnpm run changeset` / `pnpm run changeset:check`).
 *
 * Uses the Changesets CLI natively:
 *   - `changeset status --since <ref>` — which workspace packages changed (kb vs kb-server)
 *   - `changeset add --since <ref>` — wizard only prompts for changed packages
 *
 * Local: pending changeset only (no package.json bump). CI on main: `changeset version` + version.tex.
 *
 * Workspace packages (see pnpm-workspace.yaml):
 *   - `kb` — CLI + src/server runtime
 *   - `kb-server` — Docker, httpyac contract, integration scripts (fixed to kb version)
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateChangesetConsistency } from './check-changeset-consistency.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changesetBin = path.join(root, 'node_modules', '.bin', 'changeset')

function parseArgs(argv) {
  let since = 'main'
  let checkOnly = false
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--check') {
      checkOnly = true
      continue
    }
    if (argv[i] === '--since' && argv[i + 1]) {
      since = argv[++i]
      continue
    }
    if (argv[i] === '--base' && argv[i + 1]) {
      since = argv[++i].replace(/^origin\//, '')
      continue
    }
    throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return { since, checkOnly }
}

function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf-8' }).trim()
}

function listPendingChangesets() {
  const dir = path.join(root, '.changeset')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .map(name => `.changeset/${name}`)
}

function readPackageVersion(ref) {
  return JSON.parse(git(`show ${ref}:package.json`)).version
}

function readHeadPackageVersion() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')).version
}

function runChangesetCli(args, { allowFailure = false } = {}) {
  try {
    execSync(`"${changesetBin}" ${args}`, { stdio: 'inherit', cwd: root })
    return 0
  } catch (error) {
    if (allowFailure) return error.status ?? 1
    throw error
  }
}

function runPolicyCheck(since) {
  const ref = since.includes('/') ? since : `origin/${since}`
  try {
    git(`fetch --no-tags origin ${since}`)
  } catch {
    // offline ok
  }

  const changedFiles = git(`diff --name-only ${ref}...HEAD`)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const result = evaluateChangesetConsistency({
    changedFiles,
    pendingChangesets: listPendingChangesets(),
    basePackageVersion: readPackageVersion(ref),
    headPackageVersion: readHeadPackageVersion(),
  })

  for (const note of result.notes) console.log(`✓ ${note}`)
  if (!result.ok) {
    for (const error of result.errors) console.error(`❌ ${error}`)
    process.exit(1)
  }
}

const { since, checkOnly } = parseArgs(process.argv)

console.log(`▶ Changesets (--since ${since})`)
runPolicyCheck(since)

const statusCode = runChangesetCli(`status --since=${since} --verbose`, { allowFailure: true })
if (statusCode !== 0) {
  console.error('❌ changeset status: add or update pending changesets for changed packages')
  if (checkOnly) process.exit(statusCode)
}

if (checkOnly) {
  console.log('✓ Changeset check complete.')
  process.exit(statusCode)
}

if (!process.env.CI) {
  console.log('')
  runChangesetCli(`add --since=${since}`)
  console.log('✓ Pending changeset added. Version bump happens on merge to main (Changesets action).')
} else {
  runChangesetCli('version')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
  const releaseDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  writeFileSync(
    path.join(root, 'research', 'version.tex'),
    `% Auto-generated — do not edit by hand.\n\\def\\kbversion{${pkg.version}}\n\\def\\kbreleasedate{${releaseDate}}\n`,
    'utf-8'
  )
  console.log(`→ v${pkg.version} (${releaseDate})`)
}
