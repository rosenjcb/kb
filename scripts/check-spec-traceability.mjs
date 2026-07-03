/**
 * spec.md traceability checker.
 *
 * Hard gate: every TC-N row in a governing *.spec.md must have at least one
 * matching [TC-N] test (Vitest or httpyac) in that spec's scope.
 *
 * Scope is **decentralized** — each spec declares the tests it governs in its own
 * `sources:` frontmatter (per the spec.md / OKF standard); there is no central
 * manifest. A test file is owned by the spec whose `sources:` claims it most
 * specifically (exact file > glob > directory), so specs sharing a directory
 * (e.g. everything under `tests/tools`) stay isolated. Ambiguous ownership (two
 * specs claiming the same file at equal specificity) is a hard error — tighten the
 * `sources:` lists.
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

/** @typedef {{ spec: string, testGlobs: string[] }} SpecEntry */

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

/** Recursively find every `*.spec.md` in the repo (skips node_modules / dist / .git). */
function findSpecFiles(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = path.join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) findSpecFiles(full, out)
    else if (name.endsWith('.spec.md')) out.push(full)
  }
  return out
}

/**
 * Read the `sources:` frontmatter of a spec and return the repo-relative test paths it
 * declares (test dirs, `*.test.ts` globs, or `.http` files). Implementation-source entries
 * (the spec's own `.ts`, its directory) are ignored — they carry OKF retrieval context, not
 * test scope.
 */
function parseSourcesTestPaths(specAbsPath) {
  const specDir = path.dirname(specAbsPath)
  const content = readFileSync(specAbsPath, 'utf-8')
  const m = content.match(/^sources:\s*(.+)$/m)
  if (!m) return []
  const out = []
  for (const raw of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
    // `tests/…` entries are normalized to repo-relative regardless of the leading `../` prefix:
    // specs at different directory depths write inconsistent prefixes, but the `tests/…` tail is
    // unambiguous. `.http` / `.test.ts` entries without a `tests/` segment resolve spec-relative.
    const ti = raw.indexOf('tests/')
    if (ti >= 0) {
      out.push(raw.slice(ti))
    } else if (raw.endsWith('.http') || raw.endsWith('.test.ts')) {
      out.push(rel(path.resolve(specDir, raw)))
    }
  }
  return out
}

/**
 * How specifically `pattern` claims `file`: exact match wins over a glob, which wins over a
 * directory prefix. Returns -1 when the pattern does not match the file at all.
 */
function claimSpecificity(pattern, file) {
  if (pattern.includes('*')) {
    const re = new RegExp(
      `^${pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`
    )
    return re.test(file) ? 500 + pattern.length : -1
  }
  if (pattern === file) return 1000
  if (file.startsWith(`${pattern}/`)) return pattern.length
  return -1
}

/**
 * Build the per-spec test scope from every spec's `sources:` frontmatter, assigning each test
 * file to the spec that claims it most specifically. Throws on ambiguous ownership so the fix
 * (tighten a `sources:` list) is forced rather than silently mis-scored.
 * @returns {SpecEntry[]}
 */
export function discoverSpecEntries() {
  const specs = findSpecFiles().map(abs => ({
    spec: rel(abs),
    sources: parseSourcesTestPaths(abs),
  }))
  const testFiles = [
    ...walkFiles(path.join(root, 'tests'), '.test.ts'),
    ...walkFiles(path.join(root, 'packages'), '.http'),
  ].map(rel)

  const owned = new Map(specs.map(s => [s.spec, []]))
  const conflicts = []
  for (const file of testFiles) {
    let bestSpec = null
    let bestScore = -1
    let tied = false
    for (const s of specs) {
      let score = -1
      for (const p of s.sources) score = Math.max(score, claimSpecificity(p, file))
      if (score < 0) continue
      if (score > bestScore) {
        bestScore = score
        bestSpec = s.spec
        tied = false
      } else if (score === bestScore && s.spec !== bestSpec) {
        tied = true
      }
    }
    if (bestScore < 0) continue
    if (tied) conflicts.push(file)
    else owned.get(bestSpec).push(file)
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Ambiguous spec ownership — tighten sources: for these test files:\n  ${conflicts.join('\n  ')}`
    )
  }
  return specs
    .filter(s => parseSpecTcRows(s.spec).length > 0 || owned.get(s.spec).length > 0)
    .map(s => ({ spec: s.spec, testGlobs: owned.get(s.spec) }))
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
  const manifest = input.manifest ?? discoverSpecEntries()

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
