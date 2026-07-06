/**
 * Merge-to-main version gate.
 *
 * Policy: the version bump is a deterministic step you run ON the branch before merging.
 * First create one pending `.changeset/*.md`, then run `pnpm run changeset:version` to
 * apply it. It is NOT performed automatically after merge. This gate, which runs on PRs
 * into main, enforces that the bump was applied.
 *
 * `@kb/client`, `@kb/core`, and `@kb/server` are versioned independently. When shipped
 * source changes we require:
 *   - the affected package's `version` is bumped vs the base branch, and
 *   - no pending `.changeset/*.md` remain (they must be consumed by `changeset version`),
 *   - exactly one changeset was present before it was applied (no multi-changeset PRs), and
 *   - the version moved forward by exactly one semver step (patch, minor, or major — no double-jumps), and
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

const KB_CLIENT_PKG = 'packages/kb-client/package.json'
const KB_CORE_PKG = 'packages/kb-core/package.json'
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
  try {
    return JSON.parse(git(`show ${ref}:${file}`)).version
  } catch {
    // Monorepo migration: @kb/client lived at repo root before the split.
    if (file === KB_CLIENT_PKG) {
      try {
        return JSON.parse(git(`show ${ref}:package.json`)).version
      } catch {
        return null
      }
    }
    return null
  }
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

function compareSemver(a, b) {
  const [aMaj, aMin, aPat] = parseSemver(a)
  const [bMaj, bMin, bPat] = parseSemver(b)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return aPat - bPat
}

/** True when head is exactly one semver step ahead of base (patch, minor, or major). */
export function isSingleSemverStep(base, head) {
  const [bMaj, bMin, bPat] = parseSemver(base)
  const [hMaj, hMin, hPat] = parseSemver(head)
  if (hMaj === bMaj && hMin === bMin && hPat === bPat + 1) return true
  if (hMaj === bMaj && hMin === bMin + 1 && hPat === 0) return true
  if (hMaj === bMaj + 1 && hMin === 0 && hPat === 0) return true
  return false
}

function formatExpectedBumpSteps(base) {
  const [maj, min, pat] = parseSemver(base)
  return `${maj}.${min}.${pat + 1} (patch), ${maj}.${min + 1}.0 (minor), or ${maj + 1}.0.0 (major)`
}

/** Head must be exactly one semver step ahead of base. */
function isValidVersionBump(base, head) {
  return isSingleSemverStep(base, head)
}

export function shippedSourceChanged(changedFiles) {
  const shipped = changedFiles.filter(file => !file.endsWith('.spec.md'))
  const changed = new Set(shipped)
  const clientSourceChanged = [...changed].some(
    file =>
      file.startsWith('packages/kb-client/') ||
      file.startsWith('scripts/build-client.mjs') ||
      file.startsWith('src/') ||
      file.startsWith('bin/')
  )
  const coreSourceChanged = [...changed].some(file => file.startsWith('packages/kb-core/'))
  const serverSourceChanged = [...changed].some(
    file =>
      (file.startsWith('packages/kb-server/') && !file.startsWith('packages/kb-server/http/')) ||
      file.startsWith('scripts/build-server.mjs')
  )
  return { clientSourceChanged, coreSourceChanged, serverSourceChanged, any: clientSourceChanged || coreSourceChanged || serverSourceChanged }
}

function packageJsonPathFor(name) {
  if (name === '@kb/client') return KB_CLIENT_PKG
  if (name === '@kb/core') return KB_CORE_PKG
  if (name === '@kb/server') return KB_SERVER_PKG
  throw new Error(`Unknown package: ${name}`)
}

function readVersionFromFile(absPath) {
  if (!existsSync(absPath)) return null
  return JSON.parse(readFileSync(absPath, 'utf-8')).version
}

function readVersionAtRef(ref, file) {
  try {
    return JSON.parse(git(`show ${ref}:${file}`)).version
  } catch {
    return null
  }
}

/** Pre-commit: shipped source in the index must carry a changeset or an applied version bump. */
export function evaluateStagedChangesetGuard(input) {
  const errors = []
  const notes = []
  const { clientSourceChanged, coreSourceChanged, serverSourceChanged, any } = shippedSourceChanged(
    input.stagedFiles
  )

  if (!any) {
    notes.push('No shipped source staged — changeset not required.')
    return { ok: true, errors, notes }
  }

  if (input.pendingChangesets.length > 1) {
    errors.push(
      `At most one pending changeset allowed; found ${input.pendingChangesets.length}. Run \`pnpm run changeset:version\` or remove extras.`
    )
    return { ok: false, errors, notes }
  }

  const stagedSet = new Set(input.stagedFiles)
  const changesetStaged = input.stagedFiles.some(f => f.startsWith('.changeset/') && f.endsWith('.md') && !f.endsWith('README.md'))

  if (input.pendingChangesets.length === 1 || changesetStaged) {
    notes.push('Shipped source staged with a pending changeset — OK before `changeset:version`.')
    return { ok: true, errors, notes }
  }

  const checks = [
    [clientSourceChanged, '@kb/client', input.kbClientHead, input.kbClientStaged, input.kbClientBase],
    [coreSourceChanged, '@kb/core', input.kbCoreHead, input.kbCoreStaged, input.kbCoreBase],
    [serverSourceChanged, '@kb/server', input.kbServerHead, input.kbServerStaged, input.kbServerBase],
  ]

  for (const [flag, name, headVersion, stagedVersion, baseVersion] of checks) {
    if (!flag) continue
    const pkg = packageJsonPathFor(name)
    if (!stagedSet.has(pkg)) {
      if (
        baseVersion &&
        headVersion &&
        headVersion !== baseVersion &&
        isValidVersionBump(baseVersion, headVersion)
      ) {
        notes.push(`${name} source staged; version already bumped on branch (${baseVersion} → ${headVersion}).`)
        continue
      }
      errors.push(
        `${name} source is staged but no changeset is pending. Add \`.changeset/*.md\` or stage an applied bump (\`${pkg}\`).`
      )
      continue
    }
    if (headVersion === stagedVersion) {
      errors.push(`${name} source is staged but \`${pkg}\` version was not bumped (still ${headVersion}).`)
      continue
    }
    try {
      if (compareSemver(headVersion, stagedVersion) > 0) {
        notes.push(
          `${name} staged version ${stagedVersion} is behind HEAD ${headVersion} — pre-push validates vs origin/main.`
        )
        continue
      }
      if (!isValidVersionBump(headVersion, stagedVersion)) {
        errors.push(
          `${name} version bump must be exactly one semver step (${headVersion} → expected one of ${formatExpectedBumpSteps(headVersion)}; got ${stagedVersion}).`
        )
        continue
      }
    } catch {
      errors.push(`${name} version is not valid semver (HEAD: ${headVersion}, staged: ${stagedVersion}).`)
      continue
    }
    notes.push(`${name} staged bump ${headVersion} → ${stagedVersion}`)
  }

  return { ok: errors.length === 0, errors, notes }
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

  const { clientSourceChanged, coreSourceChanged, serverSourceChanged } = shippedSourceChanged(input.changedFiles)

  if (!clientSourceChanged && !coreSourceChanged && !serverSourceChanged) {
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
    if (versions.base === null) {
      if (!versions.head) {
        errors.push(`${name} introduced on this branch but has no version in ${name}.`)
      } else {
        notes.push(`${name} introduced at ${versions.head}`)
      }
      return
    }
    if (versions.base === versions.head) {
      errors.push(
        `${name} source changed but its version was not bumped (still ${versions.base}). Create one pending \`.changeset/*.md\`, then run \`pnpm run changeset:version\`.`
      )
      return
    }
    try {
      if (!isValidVersionBump(versions.base, versions.head)) {
        if (compareSemver(versions.base, versions.head) >= 0) {
          errors.push(
            `${name} version did not move forward (${versions.base} → ${versions.head}). Bump with \`pnpm run changeset:version\`.`
          )
        } else {
          errors.push(
            `${name} version jumped more than one semver step (${versions.base} → ${versions.head}). Expected exactly one of: ${formatExpectedBumpSteps(versions.base)}. Split into separate PRs or rebase to a single changeset bump.`
          )
        }
        return
      }
    } catch {
      errors.push(`${name} version is not valid semver (base: ${versions.base}, head: ${versions.head}).`)
      return
    }
    notes.push(`${name} ${versions.base} → ${versions.head}`)
  }

  requireBump(clientSourceChanged, '@kb/client', input.kbClient)
  requireBump(coreSourceChanged, '@kb/core', input.kbCore)
  requireBump(serverSourceChanged, '@kb/server', input.kbServer)

  return { ok: errors.length === 0, errors, notes }
}

function assertNoPendingChangesets() {
  const pending = listPendingChangesets()
  if (pending.length === 0) {
    console.log('✓ No pending changesets.')
    return
  }
  for (const file of pending) {
    console.error(`❌ Pending changeset on main: ${file}`)
  }
  console.error(
    'Apply the bump on the PR branch (`pnpm run changeset:version`), commit, then merge. Main must never carry unconsumed changesets.'
  )
  process.exit(1)
}

function main() {
  if (process.argv.includes('--assert-no-pending')) {
    assertNoPendingChangesets()
    return
  }

  if (process.argv.includes('--staged')) {
    const stagedFiles = git('diff --cached --name-only')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    const readStagedVersion = pkg =>
      stagedFiles.includes(pkg) ? readVersionFromFile(path.join(root, pkg)) : readVersionAtRef('HEAD', pkg)
    const result = evaluateStagedChangesetGuard({
      stagedFiles,
      pendingChangesets: listPendingChangesets(),
      kbClientHead: readVersionAtRef('HEAD', KB_CLIENT_PKG),
      kbClientStaged: readStagedVersion(KB_CLIENT_PKG),
      kbClientBase: readVersionAtRef('origin/main', KB_CLIENT_PKG),
      kbCoreHead: readVersionAtRef('HEAD', KB_CORE_PKG),
      kbCoreStaged: readStagedVersion(KB_CORE_PKG),
      kbCoreBase: readVersionAtRef('origin/main', KB_CORE_PKG),
      kbServerHead: readVersionAtRef('HEAD', KB_SERVER_PKG),
      kbServerStaged: readStagedVersion(KB_SERVER_PKG),
      kbServerBase: readVersionAtRef('origin/main', KB_SERVER_PKG),
    })
    for (const note of result.notes) console.log(`✓ ${note}`)
    if (!result.ok) {
      for (const error of result.errors) console.error(`❌ ${error}`)
      process.exit(1)
    }
    console.log('✓ Staged changeset guard passed.')
    return
  }

  if (process.argv.includes('--push')) {
    runMergeGate('origin/main')
    return
  }

  const { base } = parseArgs(process.argv)
  runMergeGate(base)
}

function runMergeGate(base) {
  try {
    git(`fetch --no-tags origin ${base.replace(/^origin\//, '')}`)
  } catch {
    // Local branch without remote — compare to main if present.
  }
  const changedFiles = git(`diff --name-only ${base}...HEAD`)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  const result = evaluateChangesetConsistency({
    changedFiles,
    pendingChangesets: listPendingChangesets(),
    kbClient: {
      base: readVersionAt(base, KB_CLIENT_PKG),
      head: readHeadVersion(KB_CLIENT_PKG),
    },
    kbCore: {
      base: readVersionAt(base, KB_CORE_PKG),
      head: readHeadVersion(KB_CORE_PKG),
    },
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

function mainEntry() {
  main()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  mainEntry()
}
