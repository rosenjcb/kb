/**
 * Merge-to-main version gate.
 *
 * Policy: the version bump is a deterministic step you run ON the branch before merging
 * (`pnpm run changeset` to draft a changeset, then `pnpm run changeset:version` to apply
 * it). It is NOT performed automatically after merge. This gate, which runs on PRs into
 * main, enforces that the bump was applied.
 *
 * `kb` (CLI; `src/`, `bin/`), `kb-server` (Docker/contract; `packages/kb-server/`), and
 * `kb-slack` (Slack bot; `packages/kb-slack/`) are versioned independently. So when shipped
 * source changes we require:
 *   - the affected package's `version` is bumped vs the base branch, and
 *   - no pending `.changeset/*.md` remain (they must be consumed by `changeset version`).
 *
 * Docs/config-only PRs need no bump.
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
const KB_SLACK_PKG = 'packages/kb-slack/package.json'

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

export function evaluateChangesetConsistency(input) {
  const errors = []
  const notes = []

  const changed = new Set(input.changedFiles)
  const kbSourceChanged = [...changed].some(
    file => file.startsWith('src/') || file.startsWith('bin/')
  )
  const serverSourceChanged = [...changed].some(file => file.startsWith('packages/kb-server/'))
  const slackSourceChanged = [...changed].some(file => file.startsWith('packages/kb-slack/'))

  if (!kbSourceChanged && !serverSourceChanged && !slackSourceChanged) {
    notes.push('No shipped source changes — version bump not required.')
    return { ok: true, errors, notes }
  }

  // The bump is applied on the branch; by merge time the changesets must be consumed.
  if (input.pendingChangesets.length > 0) {
    errors.push(
      `Pending changeset(s) not applied: ${input.pendingChangesets.join(', ')}. Run \`pnpm run changeset:version\` to bump the affected package(s) and consume the changeset(s), then commit the result.`
    )
  }

  const requireBump = (changedFlag, name, versions) => {
    if (!changedFlag) return
    if (versions.base === versions.head) {
      errors.push(
        `${name} source changed but its version was not bumped (still ${versions.base}). Draft a changeset (\`pnpm run changeset\`) then apply it (\`pnpm run changeset:version\`).`
      )
    } else {
      notes.push(`${name} ${versions.base} → ${versions.head}`)
    }
  }

  requireBump(kbSourceChanged, 'kb', input.kb)
  requireBump(serverSourceChanged, 'kb-server', input.kbServer)
  requireBump(slackSourceChanged, 'kb-slack', input.kbSlack)

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
    kbSlack: {
      base: readVersionAt(base, KB_SLACK_PKG),
      head: readHeadVersion(KB_SLACK_PKG),
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
