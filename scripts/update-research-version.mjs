/**
 * Single changeset entrypoint (`pnpm run changeset`).
 * - Locally: interactive changeset wizard, then consume + bump package.json, CHANGELOG.md, research/version.tex
 * - In CI (CI=true): skips the wizard and only consumes pending changesets
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changesetBin = path.join(root, 'node_modules', '.bin', 'changeset')

function runChangeset(args) {
  execSync(`"${changesetBin}" ${args}`, { stdio: 'inherit', cwd: root })
}

if (!process.env.CI) {
  runChangeset('')
}

runChangeset('version')

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
