import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LLMCallParams, LLMProvider, LLMResponse } from '@kb/core/core/types.js'
import { collectSourceFiles, runKbInit } from '@kb/core/ops/init-cli.js'
import { diffChangedSourceFiles, readSourceFilesManifest } from '@kb/core/ops/init-source-files-manifest.js'
import { readAstFilesManifest } from '@kb/core/ops/init-ast-files-manifest.js'
import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import { resolveBaseToDir } from '@kb/core/storage/base-selection.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

const tempDirs: string[] = []
let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-home-rescan-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  delete process.env.KB_HOME
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  if (kbHomeDir) await rm(kbHomeDir, { recursive: true, force: true })
})

function stubProvider(): LLMProvider {
  return {
    name: 'test-provider',
    model: 'test-model',
    supportsStreaming: false,
    async call(_params: LLMCallParams): Promise<LLMResponse> {
      return {
        text: JSON.stringify({ entities: [], relationships: [] }),
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
}

async function makeTempGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-rescan-repo-'))
  tempDirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const full = path.join(dir, file)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content, 'utf8')
    })
  )
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-m', 'init')
  return dir
}

/** All active facts for one repo (by git_repo column), read from a freshly opened index. */
function withIndex<T>(baseDir: string, fn: (indexer: SqliteKbIndexer) => T): T {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    return fn(indexer)
  } finally {
    indexer.close()
  }
}

function factCountForRepo(baseDir: string, slug: string): number {
  return withIndex(baseDir, i => i.listFactsForQuery(99999).filter(f => f.git_repo === slug).length)
}

function astRefsForFile(baseDir: string, slug: string, relFile: string): string[] {
  return withIndex(baseDir, i =>
    i
      .listActiveFactsBySourceRefPrefix('ast:')
      .filter(f => f.git_repo === slug && typeof f.source_ref === 'string')
      .map(f => f.source_ref as string)
      .filter(ref => ref.includes(`${relFile}@`))
  )
}

async function rescanRepo(base: string, repoDir: string, slug: string): Promise<void> {
  await runKbInit({
    base,
    cwd: repoDir,
    rescan: true,
    apply: true,
    nonInteractive: true,
    gitRepo: slug,
    provider: stubProvider(),
  })
}

describe('multi-repo incremental rescan', () => {
  it(
    '[TC-632] warm rescan of an unchanged multi-repo base detects 0 changed per repo and preserves all facts',
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'kb-rescan-cwd-'))
      tempDirs.push(cwd)
      await writeFile(path.join(cwd, 'README.md'), '# host\n', 'utf8')
      const repoA = await makeTempGitRepo({
        'README.md': '# Repo A\n\nAlpha service docs.\n',
        'src/a.ts': 'export function aOne() { return 1 }\n',
      })
      const repoB = await makeTempGitRepo({
        'README.md': '# Repo B\n\nBeta service docs.\n',
        'src/b.ts': 'export function bOne() { return 2 }\n',
      })

      await runKbInit({
        base: 'multi-rescan',
        gitTargets: [
          { url: repoA, branch: 'main' },
          { url: repoB, branch: 'main' },
        ],
        nonInteractive: true,
        cwd,
        provider: stubProvider(),
      })

      const baseDir = resolveBaseToDir('multi-rescan', cwd)
      const repos = await discoverBaseRepos(baseDir)
      expect(repos).toHaveLength(2)

      // Part A: each repo's per-slug manifest matches its on-disk tree ⇒ a rescan sees 0 changed.
      for (const repo of repos) {
        const repoDir = path.join(baseDir, repo.dir)
        const current = await collectSourceFiles(repoDir)
        const manifest = await readSourceFilesManifest(baseDir, repo.slug)
        expect(diffChangedSourceFiles(current, manifest)).toEqual([])

        const astManifest = await readAstFilesManifest(baseDir, repo.slug)
        expect(Object.keys(astManifest.files).length).toBeGreaterThan(0)
        expect(existsSync(path.join(baseDir, `source-files-manifest.${repo.slug}.json`))).toBe(true)
        expect(existsSync(path.join(baseDir, `ast-files-manifest.${repo.slug}.json`))).toBe(true)
      }
      // The single, clobber-prone legacy filenames must NOT be what the build wrote.
      expect(existsSync(path.join(baseDir, 'source-files-manifest.json'))).toBe(false)
      expect(existsSync(path.join(baseDir, 'ast-files-manifest.json'))).toBe(false)

      // Part B: an unchanged rescan of BOTH repos must not lose any facts.
      const before = repos.map(r => ({ slug: r.slug, count: factCountForRepo(baseDir, r.slug) }))
      expect(before.every(r => r.count > 0)).toBe(true)

      for (const repo of repos) {
        await rescanRepo('multi-rescan', path.join(baseDir, repo.dir), repo.slug)
      }

      for (const { slug, count } of before) {
        expect(factCountForRepo(baseDir, slug)).toBe(count)
      }
    },
    120000
  )

  it(
    '[TC-633] a changed or deleted file in one repo reindexes only that repo and never purges unchanged files or sibling repos',
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'kb-rescan-cwd2-'))
      tempDirs.push(cwd)
      await writeFile(path.join(cwd, 'README.md'), '# host\n', 'utf8')
      const repoA = await makeTempGitRepo({
        'README.md': '# Repo A\n',
        'src/a.ts': 'export function aOne() { return 1 }\n',
        'src/keep.ts': 'export function keepMe() { return 42 }\n',
      })
      const repoB = await makeTempGitRepo({
        'README.md': '# Repo B\n',
        'src/b.ts': 'export function bOne() { return 2 }\n',
      })

      await runKbInit({
        base: 'multi-partial',
        gitTargets: [
          { url: repoA, branch: 'main' },
          { url: repoB, branch: 'main' },
        ],
        nonInteractive: true,
        cwd,
        provider: stubProvider(),
      })

      const baseDir = resolveBaseToDir('multi-partial', cwd)
      const repos = await discoverBaseRepos(baseDir)
      const repoAEntry = repos.find(r => r.gitUrl === repoA)
      const repoBEntry = repos.find(r => r.gitUrl === repoB)
      if (!repoAEntry || !repoBEntry) throw new Error('expected both repos discovered')
      const repoADir = path.join(baseDir, repoAEntry.dir)

      const slugA = repoAEntry.slug
      const slugB = repoBEntry.slug
      const repoBCountInitial = factCountForRepo(baseDir, slugB)
      expect(astRefsForFile(baseDir, slugA, 'src/keep.ts').length).toBeGreaterThan(0)

      // --- Change one file in repo A (partial rescan) ---
      await writeFile(
        path.join(repoADir, 'src/a.ts'),
        'export function aOne() { return 100 }\nexport function aTwo() { return 2 }\n',
        'utf8'
      )
      await rescanRepo('multi-partial', repoADir, slugA)

      // The unchanged sibling file's facts survive (the blanket-tombstone data-loss guard).
      expect(astRefsForFile(baseDir, slugA, 'src/keep.ts').length).toBeGreaterThan(0)
      // Repo B was never scanned — its fact count is untouched.
      expect(factCountForRepo(baseDir, slugB)).toBe(repoBCountInitial)

      // --- Delete a file in repo A (pure-deletion rescan) ---
      await rm(path.join(repoADir, 'src/keep.ts'))
      await rescanRepo('multi-partial', repoADir, slugA)

      // Only the deleted file's facts are purged.
      expect(astRefsForFile(baseDir, slugA, 'src/keep.ts')).toEqual([])
      // The changed file's facts remain, and repo B is still untouched.
      expect(astRefsForFile(baseDir, slugA, 'src/a.ts').length).toBeGreaterThan(0)
      expect(factCountForRepo(baseDir, slugB)).toBe(repoBCountInitial)
    },
    120000
  )
})
