/**
 * spec.md traceability checker.
 *
 * Hard gate: every TC-N row in a governing *.spec.md must have at least one
 * matching [TC-N] test (Vitest or httpyac) in that spec's scope.
 *
 * Tests without [TC-N] tags are fine. [smoke] tests are fine. Only spec TC rows
 * must be covered.
 *
 * Usage: pnpm run spec:check
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {{ spec: string, testGlobs: string[] }} ManifestEntry */

function rel(file) {
  return path.relative(root, file).replace(/\\/g, '/')
}

function walkFiles(dir, ext, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      walkFiles(full, ext, out)
    } else if (name.endsWith(ext)) out.push(full)
  }
  return out
}

function extractQuotedName(line, openRe) {
  const m = line.match(openRe)
  if (!m) return null
  const quote = m[m.length - 1]
  const start = line.indexOf(quote, m.index) + 1
  let end = start
  while (end < line.length) {
    if (line[end] === '\\') { end += 2; continue }
    if (line[end] === quote) break
    end += 1
  }
  return line.slice(start, end)
}

function extractTcTag(name) {
  const m = name.match(/^\[(TC-\d+)\]/)
  return m ? m[1] : null
}

function collectTcTagsFromFile(filePath, kind) {
  const tags = new Set()
  const openRe = kind === 'http' ? /test\s*\(\s*(['"`])/ : /\b(it|test)\(\s*(['"`])/
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    if (kind === 'vitest' && /\bit\.todo\(|\btest\.todo\(/.test(line)) continue
    const name = extractQuotedName(line, openRe)
    if (!name) continue
    const tag = extractTcTag(name)
    if (tag) tags.add(tag)
  }
  return tags
}

function loadManifest() {
  const p = path.join(root, 'specs/MANIFEST.md')
  if (!existsSync(p)) return []
  /** @type {ManifestEntry[]} */
  const entries = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.startsWith('| `')) continue
    const cols = line.split('|').map(c => c.trim()).filter(Boolean)
    if (cols[0] === 'Spec file') continue
    entries.push({
      spec: cols[0].replace(/`/g, ''),
      testGlobs: cols[2].replace(/`/g, '').split(',').map(s => s.trim()).filter(Boolean),
    })
  }
  return entries
}

function globMatch(pattern, filePath) {
  const norm = filePath.replace(/\\/g, '/')
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`)
    return re.test(norm)
  }
  if (pattern.endsWith('/')) return norm.startsWith(pattern)
  return norm === pattern || norm.startsWith(`${pattern}/`)
}

function fileInSpecScope(filePath, entry) {
  const norm = filePath.replace(/\\/g, '/')
  return entry.testGlobs.some(g => globMatch(g, norm))
}

function parseSpecTcRows(specPath) {
  const content = readFileSync(path.join(root, specPath), 'utf-8')
  const rows = []
  let inTable = false
  for (const line of content.split('\n')) {
    if (line.includes('| Test ID |')) { inTable = true; continue }
    if (inTable && line.startsWith('### ')) break
    const m = line.match(/^\|\s*(TC-\d+)\s*\|/)
    if (m) rows.push(m[1])
  }
  return rows
}

/** Collect [TC-N] tags from all tests in a spec's manifest scope. */
export function collectTcTagsForSpec(entry) {
  const tags = new Set()
  for (const f of walkFiles(path.join(root, 'tests'), '.test.ts')) {
    const r = rel(f)
    if (fileInSpecScope(r, entry)) {
      for (const t of collectTcTagsFromFile(f, 'vitest')) tags.add(t)
    }
  }
  if (entry.spec.includes('HTTP.spec.md')) {
    for (const f of walkFiles(path.join(root, 'packages/kb-server/http'), '.http')) {
      for (const t of collectTcTagsFromFile(f, 'http')) tags.add(t)
    }
  }
  return tags
}

/** @returns {string[]} uncovered TC ids */
export function uncoveredTcRows(tcRows, testTags) {
  return tcRows.filter(tc => !testTags.has(tc))
}

export function evaluateSpecTraceability(input) {
  const errors = []
  const notes = []
  const manifest = input.manifest ?? loadManifest()

  for (const entry of manifest) {
    const specPath = path.join(root, entry.spec)
    if (!existsSync(specPath)) {
      errors.push(`Missing spec file: ${entry.spec}`)
      continue
    }
    const tcRows = parseSpecTcRows(entry.spec)
    const testTags = collectTcTagsForSpec(entry)
    const missing = uncoveredTcRows(tcRows, testTags)

    for (const tc of missing) {
      errors.push(`Uncovered TC row ${tc} in ${entry.spec} — no [${tc}] unit/integration test in scope`)
    }

    notes.push(`${entry.spec}: ${tcRows.length} TC rows, ${tcRows.length - missing.length} covered`)
  }

  return { ok: errors.length === 0, errors, notes }
}

function main() {
  const result = evaluateSpecTraceability({})
  for (const n of result.notes) console.log(`✓ ${n}`)
  if (!result.ok) {
    for (const e of result.errors) console.error(`❌ ${e}`)
    process.exit(1)
  }
  console.log('✓ All spec TC rows are covered by tests.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
