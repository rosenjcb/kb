import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ManifestValidator, extractManifest } from '../../eval/validators/manifest-validator'

const execFileAsync = promisify(execFile)

// ── extractManifest ───────────────────────────────────────────────────────────

describe('extractManifest', () => {
  it('[TC-84] returns empty array for empty string', () => {
    expect(extractManifest('')).toEqual([])
  })

  it('[TC-85] returns empty array when no manifest block present', () => {
    expect(extractManifest('I changed some things')).toEqual([])
  })

  it('[TC-86] extracts files from a fenced JSON block with manifest key', () => {
    const msg = `
Here is what I changed:

\`\`\`json
{
  "manifest": {
    "modified": ["src/foo.ts", "src/bar.ts"],
    "created": ["src/baz.ts"]
  }
}
\`\`\`
`
    expect(extractManifest(msg)).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'])
  })

  it('[TC-87] handles deleted-only manifest', () => {
    const msg = `
\`\`\`json
{"manifest": {"deleted": ["old.ts"]}}
\`\`\`
`
    expect(extractManifest(msg)).toEqual(['old.ts'])
  })

  it('[TC-88] combines modified, created, deleted in that order', () => {
    const msg = `
\`\`\`json
{
  "manifest": {
    "modified": ["a.ts"],
    "created": ["b.ts"],
    "deleted": ["c.ts"]
  }
}
\`\`\`
`
    expect(extractManifest(msg)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('[TC-89] filters out blank entries', () => {
    const msg = `
\`\`\`json
{"manifest": {"modified": ["", "src/valid.ts", "  "]}}
\`\`\`
`
    expect(extractManifest(msg)).toEqual(['src/valid.ts'])
  })

  it('[TC-90] trims whitespace from file paths', () => {
    const msg = `
\`\`\`json
{"manifest": {"modified": ["  src/foo.ts  "]}}
\`\`\`
`
    expect(extractManifest(msg)).toEqual(['src/foo.ts'])
  })

  it('[TC-91] inline fallback returns empty for nested JSON (lazy regex stops at first inner })', () => {
    // The inline pattern uses lazy [\s\S]*?\} which stops at the closing } of the
    // inner object, producing invalid JSON. Nested manifests require a fenced block.
    const msg = `The changes are {"manifest": {"created": ["inline.ts"]}} as listed.`
    expect(extractManifest(msg)).toEqual([])
  })

  it('[TC-92] prefers fenced block over inline JSON when both present', () => {
    const msg = `
\`\`\`json
{"manifest": {"modified": ["fenced.ts"]}}
\`\`\`
Also see {"manifest": {"created": ["inline.ts"]}}
`
    expect(extractManifest(msg)).toEqual(['fenced.ts'])
  })

  it('[TC-93] returns empty array when JSON is invalid', () => {
    const msg = '```json\n{bad json}\n```'
    expect(extractManifest(msg)).toEqual([])
  })

  it('[TC-94] returns empty array when JSON lacks manifest key', () => {
    const msg = '```json\n{"other": {"modified": ["x.ts"]}}\n```'
    expect(extractManifest(msg)).toEqual([])
  })

  it('[TC-95] handles non-array values in manifest fields gracefully', () => {
    const msg = '```json\n{"manifest": {"modified": "not-an-array"}}\n```'
    expect(extractManifest(msg)).toEqual([])
  })
})

// ── ManifestValidator ─────────────────────────────────────────────────────────

describe('ManifestValidator', () => {
  let tmpDir: string
  const validator = new ManifestValidator()

  async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'moel-manifest-test-'))
    // Init a bare git repo with a single commit so HEAD exists
    await git(tmpDir, 'init')
    await git(tmpDir, 'config', 'user.email', 'test@test.com')
    await git(tmpDir, 'config', 'user.name', 'Test')
    await git(tmpDir, 'config', 'commit.gpgsign', 'false')
    await writeFile(path.join(tmpDir, 'README.md'), '# test\n')
    await git(tmpDir, 'add', '.')
    await git(tmpDir, 'commit', '-m', 'init')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('[TC-96] passes when declared matches actual changes', async () => {
    await writeFile(path.join(tmpDir, 'README.md'), '# changed\n')
    const result = await validator.validate(['README.md'], tmpDir)
    expect(result.passed).toBe(true)
    expect(result.undeclaredChanges).toEqual([])
    expect(result.actual).toContain('README.md')
  })

  it('[TC-97] fails when an actual change is not declared', async () => {
    await writeFile(path.join(tmpDir, 'README.md'), '# changed\n')
    const result = await validator.validate([], tmpDir)
    expect(result.passed).toBe(false)
    expect(result.undeclaredChanges).toContain('README.md')
  })

  it('[TC-98] passes with phantom declaration (declared but not changed)', async () => {
    await writeFile(path.join(tmpDir, 'README.md'), '# changed\n')
    const result = await validator.validate(['README.md', 'phantom.ts'], tmpDir)
    expect(result.passed).toBe(true)
    expect(result.phantomDeclarations).toContain('phantom.ts')
  })

  it('[TC-99] passes with no changes and empty manifest', async () => {
    const result = await validator.validate([], tmpDir)
    expect(result.passed).toBe(true)
    expect(result.actual).toEqual([])
    expect(result.undeclaredChanges).toEqual([])
  })

  it('[TC-100] reports declared and actual on the result', async () => {
    await writeFile(path.join(tmpDir, 'README.md'), '# updated\n')
    const result = await validator.validate(['README.md'], tmpDir)
    expect(result.declared).toEqual(['README.md'])
    expect(result.actual).toContain('README.md')
  })
})
