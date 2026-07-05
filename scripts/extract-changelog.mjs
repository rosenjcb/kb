/**
 * Prints a changelog section from `packages/kb-client/CHANGELOG.md` or
 * `packages/kb-server/CHANGELOG.md` (changeset-generated release notes).
 *
 * Usage: node scripts/extract-changelog.mjs [version] [client|server]
 */
import { readFileSync } from 'node:fs'

import {
  CLIENT_CHANGELOG,
  SERVER_CHANGELOG,
} from './release-package.mjs'

const wanted = process.argv[2]?.replace(/^v/, '')
const packageName = (process.argv[3] ?? 'client').toLowerCase()

const changelogPath =
  packageName === 'server'
    ? SERVER_CHANGELOG
    : packageName === 'client'
      ? CLIENT_CHANGELOG
      : null

if (!changelogPath) {
  console.error(`Unknown package "${packageName}" — use client or server`)
  process.exit(1)
}

let changelog = ''
try {
  changelog = readFileSync(changelogPath, 'utf-8')
} catch {
  process.exit(0)
}

const lines = changelog.split('\n')
const isVersionHeading = line => /^##\s+/.test(line)

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

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim()

if (body) process.stdout.write(`${body}\n`)
