/**
 * Changesets apply entrypoint.
 *
 *   pnpm run changeset:version → `changeset version`
 *
 * This always applies the pending changeset(s), bumps the affected package
 * versions / changelogs, and rewrites `research/version.tex`.
 *
 * Drafting a pending changeset is intentionally not wrapped by a package.json
 * script anymore. Create `.changeset/*.md` directly in PRs (preferred for
 * agent/non-interactive work), or run the native Changesets CLI yourself when
 * you want the wizard.
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readClientVersion } from './release-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changesetBin = path.join(root, 'node_modules', '.bin', 'changeset')

function runChangesetCli(args) {
  execSync(`"${changesetBin}" ${args}`, { stdio: 'inherit', cwd: root })
}

function regenerateVersionTex() {
  const version = readClientVersion()
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

console.log('▶ Applying version bump (changeset version)')
runChangesetCli('version')
const { version, releaseDate } = regenerateVersionTex()
console.log(`→ kb v${version} (${releaseDate})`)
console.log('✓ Versions bumped. Commit the result; the merge-to-main gate verifies it.')
