/**
 * Changeset entrypoint (`pnpm run changeset`).
 *
 * - Locally / in an agent session: ONLY create a pending changeset (interactive
 *   wizard). The version is NOT bumped here — it bumps on merge to main.
 * - On merge to main (CI=true, run by the Changesets GitHub Action): consume the
 *   pending changesets (`changeset version`), then regenerate research/version.tex.
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
  // Feature work: add a pending changeset and stop. Do not touch version files.
  runChangeset('')
  console.log('✓ Changeset added. It stays pending until merge to main, where the')
  console.log('  Changesets action consumes it and opens a "Version Packages" PR.')
} else {
  // Release path (Changesets action on main): consume changesets + bump.
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
}
