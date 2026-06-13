/**
 * Prints the changelog entry for the most recent version in CHANGELOG.md
 * (the changeset-generated notes for the current package.json version).
 *
 * Used by .github/workflows/release-cli.yml to populate release notes so every
 * release surfaces the changeset notes for the version it ships.
 *
 * Usage: node scripts/extract-changelog.mjs [version]
 *   - With a version arg, extracts that version's section.
 *   - Without one, extracts the top-most version section.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const wanted = process.argv[2]?.replace(/^v/, '')

let changelog = ''
try {
  changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8')
} catch {
  // No changelog yet — nothing to emit.
  process.exit(0)
}

const lines = changelog.split('\n')
const isVersionHeading = (line) => /^##\s+/.test(line)

let start = -1
for (let i = 0; i < lines.length; i++) {
  if (!isVersionHeading(lines[i])) continue
  const version = lines[i].replace(/^##\s+/, '').trim()
  if (!wanted || version === wanted) {
    start = i
    break
  }
}

if (start === -1) process.exit(0)

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (isVersionHeading(lines[i])) {
    end = i
    break
  }
}

// Skip the version heading itself; the workflow renders its own header.
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim()

if (body) process.stdout.write(`${body}\n`)
