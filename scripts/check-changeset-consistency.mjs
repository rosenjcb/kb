/**
 * PR changeset / version-bump consistency check.
 *
 * When shipped source changes, require a full version bump produced by
 * `pnpm run changeset` (package.json + CHANGELOG.md + research/version.tex).
 *
 * Usage:
 *   node scripts/check-changeset-consistency.mjs --base origin/main
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILES = ['package.json', 'CHANGELOG.md', 'research/version.tex']

function parseArgs(argv) {
  let base = 'origin/main'
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) {
      base = argv[++i]
      continue
    }
    throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return { base }
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
  const raw = git(`show ${ref}:package.json`)
  return JSON.parse(raw).version
}

function readHeadPackageVersion() {
  const raw = readFileSync(path.join(root, 'package.json'), 'utf-8')
  return JSON.parse(raw).version
}

function parseVersionTex(raw) {
  const match = raw.match(/\\def\\kbversion\{([^}]+)\}/)
  return match?.[1] ?? null
}

function readHeadVersionTex() {
  const raw = readFileSync(path.join(root, 'research/version.tex'), 'utf-8')
  return parseVersionTex(raw)
}

export function evaluateChangesetConsistency(input) {
  const errors = []
  const notes = []

  const changed = new Set(input.changedFiles)
  const versionFilesChanged = VERSION_FILES.filter(file => changed.has(file))
  const sourceChanged = [...changed].some(file => file.startsWith('src/') || file.startsWith('bin/'))
  const pending = input.pendingChangesets
  const baseVersion = input.basePackageVersion
  const headVersion = input.headPackageVersion
  const headTexVersion = input.headTexVersion
  const versionBumped = baseVersion !== headVersion

  if (pending.length > 0) {
    errors.push(
      `Pending changeset file(s) remain: ${pending.join(', ')}. Run \`pnpm run changeset\` to consume them and commit the version bump files.`
    )
  }

  if (versionFilesChanged.length > 0 && versionFilesChanged.length < VERSION_FILES.length) {
    const missing = VERSION_FILES.filter(file => !versionFilesChanged.includes(file))
    errors.push(
      `Partial version bump: ${versionFilesChanged.join(', ')} changed but missing ${missing.join(', ')}. Run \`pnpm run changeset\` and commit all three files together.`
    )
  }

  if (versionBumped || versionFilesChanged.length > 0) {
    if (!versionBumped) {
      errors.push(
        'Version files changed without bumping package.json version. Run `pnpm run changeset` instead of editing version files by hand.'
      )
    }
    if (!changed.has('CHANGELOG.md')) {
      errors.push('package.json version bumped but CHANGELOG.md was not updated.')
    }
    if (!changed.has('research/version.tex')) {
      errors.push('package.json version bumped but research/version.tex was not updated.')
    }
    if (headTexVersion !== headVersion) {
      errors.push(
        `research/version.tex version (${headTexVersion ?? 'missing'}) does not match package.json (${headVersion}).`
      )
    }
  }

  if (sourceChanged) {
    if (!versionBumped) {
      errors.push(
        'Shipped source (src/ or bin/) changed without a version bump. Run `pnpm run changeset` and commit package.json, CHANGELOG.md, and research/version.tex.'
      )
    } else {
      notes.push(`Version bump: ${baseVersion} → ${headVersion}`)
    }
  } else if (!sourceChanged) {
    notes.push('No shipped source changes — version bump not required.')
  }

  return { ok: errors.length === 0, errors, notes }
}

function main() {
  const { base } = parseArgs(process.argv)
  git(`fetch --no-tags origin ${base.replace(/^origin\//, '')}`)
  const changedFiles = git(`diff --name-only ${base}...HEAD`)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const result = evaluateChangesetConsistency({
    changedFiles,
    pendingChangesets: listPendingChangesets(),
    basePackageVersion: readPackageVersion(base),
    headPackageVersion: readHeadPackageVersion(),
    headTexVersion: readHeadVersionTex(),
  })

  for (const note of result.notes) {
    console.log(`✓ ${note}`)
  }

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`❌ ${error}`)
    }
    process.exit(1)
  }

  console.log('✓ Changeset / version state is consistent.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
