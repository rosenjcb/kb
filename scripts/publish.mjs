/**
 * Called on push to main after the merge gate has ensured versions are already
 * bumped on the branch. Tags `@kb/client`'s version so release-cli.yml can
 * build and publish the CLI artifact.
 */
import { execSync } from 'node:child_process'

import { readClientVersion } from './release-package.mjs'

const version = readClientVersion()
const tag = `v${version}`

try {
  execSync(`git tag ${tag}`, { stdio: 'inherit' })
  execSync(`git push origin ${tag}`, { stdio: 'inherit' })
  console.log(`✓ Tagged @kb/client release ${tag}`)
} catch {
  // Tag already exists — idempotent re-run is fine
  console.log(`Tag ${tag} already exists, skipping`)
}
