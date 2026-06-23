/**
 * Changesets entrypoint.
 *
 *   pnpm run changeset           → `changeset add`     (draft a PENDING changeset; interactive)
 *   pnpm run changeset:version   → `changeset version` (APPLY the bump + regenerate version.tex)
 *
 * (The merge-readiness check lives in `scripts/check-changeset-consistency.mjs`, wired as
 * `pnpm run changeset:check`.)
 *
 * Versioning is a deterministic step you run on the branch before merging — `changeset:version`
 * consumes pending changesets, bumps each package's `package.json` + `CHANGELOG.md`, and rewrites
 * `research/version.tex`. The merge-to-main gate (`scripts/check-changeset-consistency.mjs`) then
 * verifies it was applied. Nothing bumps automatically after merge.
 *
 * Workspace packages (independent versions; see pnpm-workspace.yaml + .changeset/config.json):
 *   - `kb`        — CLI + src/server runtime
 *   - `kb-server` — Docker, httpyac contract, integration scripts
 *   - `kb-slack`  — Slack bot (@slack/bolt bridge to kb-server)
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changesetBin = path.join(root, 'node_modules', '.bin', 'changeset')

function parseArgs(argv) {
  let since = 'main'
  let mode = 'add'
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') {
      mode = 'apply'
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
  return { since, mode }
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

function regenerateVersionTex() {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
  const releaseDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  writeFileSync(
    path.join(root, 'research', 'version.tex'),
    `% Auto-generated — do not edit by hand.\n\\def\\kbversion{${version}}\n\\def\\kbreleasedate{${releaseDate}}\n`,
    'utf-8'
  )
  return { version, releaseDate }
}

const { since, mode } = parseArgs(process.argv)

if (mode === 'apply') {
  console.log('▶ Applying version bump (changeset version)')
  runChangesetCli('version')
  const { version, releaseDate } = regenerateVersionTex()
  console.log(`→ kb v${version} (${releaseDate})`)
  console.log('✓ Versions bumped. Commit the result; the merge-to-main gate verifies it.')
  process.exit(0)
}

// default: draft a pending changeset (interactive wizard, changed packages only)
console.log(`▶ Drafting a changeset (--since ${since})`)
runChangesetCli(`add --since=${since}`)
console.log('✓ Pending changeset added. Run `pnpm run changeset:version` before merging to main.')
