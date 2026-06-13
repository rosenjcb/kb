/**
 * Unified version bump script.
 * - Locally: runs the interactive changeset wizard, then bumps package.json + CHANGELOG + research/version.tex
 * - In CI (CI=true): skips the wizard (changeset files already exist from PRs), just consumes them
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname

if (!process.env.CI) {
  execSync('changeset', { stdio: 'inherit' })
}

execSync('changeset version', { stdio: 'inherit' })

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
