/**
 * Merge-to-main version gate.
 *
 * Policy: the version bump is a deterministic step you run ON the branch before merging.
 * First create one pending `.changeset/*.md`, then run `pnpm run changeset:version` to
 * apply it. It is NOT performed automatically after merge. This gate, which runs on PRs
 * into main, enforces that the bump was applied.
 *
 * `kb` (CLI; `src/`, `bin/`) and `kb-server` (Docker/contract; `packages/kb-server/`) are
 * versioned independently. So when shipped source changes we require:
 *   - the affected package's `version` is bumped vs the base branch, and
 *   - no pending `.changeset/*.md` remain (they must be consumed by `changeset version`),
 *   - exactly one changeset was present before it was applied (no multi-changeset PRs), and
 *   - the version moved by exactly one semver step (no double-jumps).
 *
 * Docs/config-only PRs are exempt.
 *
 * Usage:
 *   node scripts/check-changeset-consistency.mjs --base origin/main
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const KB_SERVER_PKG = 'packages/kb-server/package.json'

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

function readVersionAt(ref, file) {
  return JSON.parse(git(`show ${ref}:${file}`)).version
}

function readHeadVersion(file) {
  return JSON.parse(readFileSync(path.join(root, file), 'utf-8')).version
}

/** Parse a semver string into [major, minor, patch] integers. */
function parseSemver(version) {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n) || n < 0)) {
    throw new Error(`Cannot parse semver: ${version}`)
  }
  return parts
}

/**
 * Returns true only when `head` is exactly one semver step ahead of `base`:
 *   major+1 (with minor/patch reset to 0), minor+1 (with patch reset to 0), or patch+1.
 */
function isExactlyOneStep(base, head) {
  const [bMaj, bMin, bPat] = parseSemver(base)
  const [hMaj, hMin, hPat] = parseSemver(head)
  return (
    (hMaj === bMaj + 1 && hMin === 0       && hPat === 0      ) || // major bump
    (hMaj === bMaj     && hMin === bMin + 1 && hPat === 0      ) || // minor bump
    (hMaj === bMaj     && hMin === bMin     && hPat === bPat + 1)    // patch bump
  )
}

export function evaluateChangesetConsistency(input) {
  const errors = []
  const notes = []

  // Policy: a PR may carry at most one changeset file. Multiple changesets indicate
  // that several independent changes were squashed into one PR — each should have had
  // its own PR, or the extras should be removed before applying the bump.
  if (input.pendingChangesets.length > 1) {
    errors.push(
      `A PR may carry at most one changeset; found ${input.pendingChangesets.length}: ${input.pendingChangesets.join(', ')}. Remove or merge the extras, then run \`pnpm run changeset:version\`.`
    )
    return { ok: false, errors, notes }
  }

  const changed = new Set(input.changedFiles)
  const kbSourceChanged = [...changed].some(
    file => file.startsWith('src/') || file.startsWith('bin/')
  )
  const serverSourceChanged = [...changed].some(
    file => file.startsWith('packages/kb-server/') && !file.startsWith('packages/kb-server/http/')
  )

  if (!kbSourceChanged && !serverSourceChanged) {
    notes.push('No shipped source changes — version bump not required.')
    return { ok: true, errors, notes }
  }

  // The bump is applied on the branch; by merge time the single changeset must be consumed.
  if (input.pendingChangesets.length === 1) {
    errors.push(
      `Pending changeset not applied: ${input.pendingChangesets[0]}. Run \`pnpm run changeset:version\` to bump the affected package(s) and consume the changeset, then commit the result.`
    )
  }

  const requireBump = (changedFlag, name, versions) => {
    if (!changedFlag) return
    if (versions.base === versions.head) {
      errors.push(
        `${name} source changed but its version was not bumped (still ${versions.base}). Create one pending \`.changeset/*.md\`, then run \`pnpm run changeset:version\`.`
      )
      return
    }
    // Version was bumped — verify it moved by exactly one step.
    try {
      if (!isExactlyOneStep(versions.base, versions.head)) {
        errors.push(
          `${name} version jumped more than one step (${versions.base} → ${versions.head}). A PR may only bump a version by a single semver step. Check whether multiple changesets were applied at once or the version was edited by hand.`
        )
        return
      }
    } catch {
      errors.push(`${name} version is not valid semver (base: ${versions.base}, head: ${versions.head}).`)
      return
    }
    notes.push(`${name} ${versions.base} → ${versions.head}`)
  }

  requireBump(kbSourceChanged, 'kb', input.kb)
  requireBump(serverSourceChanged, 'kb-server', input.kbServer)

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
    kb: { base: readVersionAt(base, 'package.json'), head: readHeadVersion('package.json') },
    kbServer: {
      base: readVersionAt(base, KB_SERVER_PKG),
      head: readHeadVersion(KB_SERVER_PKG),
    },
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

  console.log('✓ Version bump is consistent.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
