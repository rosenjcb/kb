#!/usr/bin/env node
// Generate scripts/fly/bases.json — the single source of truth for which bases
// the Fly build-to-serve orchestration indexes and serves.
//
// Each eval suite under eval/suites/*.yaml that names a `repo_url` becomes a
// selectable base (the suite `id` is the base slug). The list is deduped by repo
// URL and always starts with the golden default base `kb` = this repo
// (rosenjcb/kb), so suites that point back at kb collapse
// into `kb` instead of re-indexing the same tree.
//
// Suites without a `repo_url` (e.g. `generic`, which is a repo-neutral question
// pack) and anything in EXCLUDE are skipped.
//
// Run after adding/removing an eval suite:
//   node scripts/fly/gen-bases.mjs        # rewrites scripts/fly/bases.json
//   node scripts/fly/gen-bases.mjs --check # CI: fail if bases.json is stale
//
// The builder (refresh.sh) and serving node (serve-entrypoint.sh) both read the
// committed bases.json from the image, so this generator never runs on Fly.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const SUITES_DIR = path.join(REPO_ROOT, 'eval', 'suites')
const OUT_FILE = path.join(HERE, 'bases.json')

// The golden default base: this repo, served when no `X-KB-Base` is given. Its
// repo URL also de-dupes suites that share a tree (e.g. only `kb` for this repo).
const DEFAULT_BASE = {
  name: 'kb',
  repo: 'https://github.com/rosenjcb/kb.git',
  branch: 'main',
  default: true,
}

// Suites to never turn into a base even when they carry a repo_url.
const EXCLUDE = new Set(['generic', 'course'])

/** Normalize a git URL for de-dup: lowercase, drop scheme/creds/.git/trailing slash. */
function repoKey(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/(?:git@)?/, 'https://')
    .replace(/^https?:\/\//, '')
}

/** Pull `key: value` off the first matching top-level line (good enough for these YAMLs). */
function scalar(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''
}

function buildBases() {
  const seen = new Set([repoKey(DEFAULT_BASE.repo)])
  const bases = [DEFAULT_BASE]

  const files = readdirSync(SUITES_DIR)
    .filter(f => f.endsWith('.yaml'))
    .sort()

  for (const file of files) {
    const yaml = readFileSync(path.join(SUITES_DIR, file), 'utf8')
    const id = scalar(yaml, 'id') || path.basename(file, '.yaml')
    const repo = scalar(yaml, 'repo_url')
    if (!repo || EXCLUDE.has(id)) continue
    const key = repoKey(repo)
    if (seen.has(key)) continue // already represented (e.g. kb → demo)
    seen.add(key)
    bases.push({ name: id, repo })
  }

  return { default: DEFAULT_BASE.name, bases }
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

const manifest = buildBases()
const rendered = serialize(manifest)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT_FILE, 'utf8')
  } catch {
    // missing → stale
  }
  if (current !== rendered) {
    console.error(
      'scripts/fly/bases.json is stale. Regenerate it:\n  node scripts/fly/gen-bases.mjs'
    )
    process.exit(1)
  }
  console.log(`scripts/fly/bases.json is up to date (${manifest.bases.length} bases).`)
} else {
  writeFileSync(OUT_FILE, rendered)
  console.log(
    `Wrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${manifest.bases.length} bases: ${manifest.bases
      .map(b => b.name)
      .join(', ')}`
  )
}
