/**
 * Called by the Changesets GitHub Action as the `publish` command after the
 * "Version Packages" PR is merged. Creates a git tag for the new version so
 * the existing release-cli.yml workflow picks it up and builds the CLI artifact.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const tag = `v${version}`

try {
  execSync(`git tag ${tag}`, { stdio: 'inherit' })
  execSync(`git push origin ${tag}`, { stdio: 'inherit' })
  console.log(`✓ Tagged release ${tag}`)
} catch {
  // Tag already exists — idempotent re-run is fine
  console.log(`Tag ${tag} already exists, skipping`)
}
