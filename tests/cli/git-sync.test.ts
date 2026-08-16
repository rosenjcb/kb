import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  baseNameFromGitUrl,
  buildGitAuthEnv,
  cloneRepo,
  getCurrentBranch,
  getHeadSha,
  isAncestorOfHead,
  pullRepo,
  resetToSha,
} from '@kb/core/ops/git-sync.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('git-sync', () => {
  describe('baseNameFromGitUrl', () => {
    it('[TC-NYZ4] derives name from https URL with .git suffix', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo.git')).toBe('org-repo')
    })

    it('[TC-76VJ] derives name from https URL without .git suffix', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo')).toBe('org-repo')
    })

    it('[TC-H1NA] derives name from https URL with trailing slash', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo/')).toBe('org-repo')
    })

    it('[TC-KXS2] derives name from ssh URL', () => {
      expect(baseNameFromGitUrl('git@github.com:org/repo.git')).toBe('org-repo')
    })

    it('[TC-XVFS] lowercases the result', () => {
      expect(baseNameFromGitUrl('https://github.com/MyOrg/MyRepo')).toBe('myorg-myrepo')
    })

    it('[TC-G8ZP] replaces special characters (but keeps underscore, dot, dash) with dashes', () => {
      // underscore and dot are allowed; spaces/colons would be replaced
      expect(baseNameFromGitUrl('https://github.com/my_org/my.repo')).toBe('my_org-my.repo')
    })
  })

  describe('cloneRepo', () => {
    let tmpRoot: string
    let bareOrigin: string

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    }

    beforeEach(async () => {
      tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-git-sync-clone-'))
      bareOrigin = path.join(tmpRoot, 'origin.git')

      await git(tmpRoot, 'init', '--bare', '-b', 'master', bareOrigin)

      const seedDir = path.join(tmpRoot, 'seed')
      await mkdir(seedDir, { recursive: true })
      await git(seedDir, 'init', '-b', 'master')
      await git(seedDir, 'config', 'user.email', 'test@test.com')
      await git(seedDir, 'config', 'user.name', 'Test')
      await git(seedDir, 'config', 'commit.gpgsign', 'false')
      await writeFile(path.join(seedDir, 'README.md'), '# v1\n')
      await git(seedDir, 'add', '.')
      await git(seedDir, 'commit', '-m', 'v1')
      await git(seedDir, 'remote', 'add', 'origin', bareOrigin)
      await git(seedDir, 'push', '-u', 'origin', 'master')
    })

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true })
    })

    it('[TC-4IUC] Given no branch, then clones the remote default branch', async () => {
      const cloneDir = path.join(tmpRoot, 'clone-default')
      await cloneRepo(bareOrigin, cloneDir)
      expect(await getCurrentBranch(cloneDir)).toBe('master')
    })

    it('[TC-UOHK] Given an explicit branch, then clones that branch', async () => {
      const cloneDir = path.join(tmpRoot, 'clone-explicit')
      await cloneRepo(bareOrigin, cloneDir, 'master')
      expect(await getCurrentBranch(cloneDir)).toBe('master')
    })
  })

  describe('buildGitAuthEnv', () => {
    it('[TC-40R5] disables interactive git prompts even without a token', () => {
      expect(buildGitAuthEnv({})).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
      })
    })

    it('[TC-JAHP] uses GITHUB_TOKEN when present', () => {
      const env = buildGitAuthEnv({ GITHUB_TOKEN: 'secret' })

      expect(env.GIT_CONFIG_COUNT).toBe('1')
      expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
      expect(env.GIT_CONFIG_VALUE_0).toBe(
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:secret').toString('base64')}`
      )
    })

    it('[TC-IEOG] falls back to GH_TOKEN when GITHUB_TOKEN is absent', () => {
      const env = buildGitAuthEnv({ GH_TOKEN: 'secret' })

      expect(env.GIT_CONFIG_COUNT).toBe('1')
      expect(env.GIT_CONFIG_VALUE_0).toBe(
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:secret').toString('base64')}`
      )
    })

    it('[TC-YE33] prefers GITHUB_TOKEN over GH_TOKEN when both are present', () => {
      const env = buildGitAuthEnv({ GITHUB_TOKEN: 'preferred', GH_TOKEN: 'fallback' })

      expect(env.GIT_CONFIG_VALUE_0).toBe(
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:preferred').toString('base64')}`
      )
    })
  })

  describe('pullRepo', () => {
    let tmpRoot: string
    let bareOrigin: string
    let cloneDir: string

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    }

    async function setBareHead(branch: string): Promise<void> {
      await execFileAsync('git', [
        '--git-dir',
        bareOrigin,
        'symbolic-ref',
        'HEAD',
        `refs/heads/${branch}`,
      ])
    }

    beforeEach(async () => {
      tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-git-sync-pull-'))
      bareOrigin = path.join(tmpRoot, 'origin.git')
      cloneDir = path.join(tmpRoot, 'clone')

      await git(tmpRoot, 'init', '--bare', '-b', 'main', bareOrigin)

      const seedDir = path.join(tmpRoot, 'seed')
      await mkdir(seedDir, { recursive: true })
      await git(seedDir, 'init', '-b', 'main')
      await git(seedDir, 'config', 'user.email', 'test@test.com')
      await git(seedDir, 'config', 'user.name', 'Test')
      await git(seedDir, 'config', 'commit.gpgsign', 'false')
      await writeFile(path.join(seedDir, 'README.md'), '# v1\n')
      await writeFile(path.join(seedDir, '.kb'), 'kb\n')
      await git(seedDir, 'add', '.')
      await git(seedDir, 'commit', '-m', 'v1')
      await git(seedDir, 'remote', 'add', 'origin', bareOrigin)
      await git(seedDir, 'push', '-u', 'origin', 'main')
      await setBareHead('main')

      await git(tmpRoot, 'clone', '--branch', 'main', bareOrigin, cloneDir)
      await git(cloneDir, 'config', 'user.email', 'test@test.com')
      await git(cloneDir, 'config', 'user.name', 'Test')
      await git(cloneDir, 'config', 'commit.gpgsign', 'false')
    })

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true })
    })

    it('[TC-H95Q] Given a dirty .kb marker in the clone, then pull succeeds', async () => {
      await writeFile(path.join(cloneDir, '.kb'), 'kb-git-4\n')

      const seedDir = path.join(tmpRoot, 'seed')
      await rm(path.join(seedDir, '.kb'))
      await writeFile(path.join(seedDir, 'README.md'), '# v2\n')
      await git(seedDir, 'add', '.')
      await git(seedDir, 'commit', '-m', 'v2')
      await git(seedDir, 'push', 'origin', 'main')

      const hadNewCommits = await pullRepo(cloneDir)

      expect(hadNewCommits).toBe(true)
      expect(await readFile(path.join(cloneDir, 'README.md'), 'utf8')).toBe('# v2\n')
      await expect(readFile(path.join(cloneDir, '.kb'), 'utf8')).rejects.toThrow()
    })

    it('[TC-FDTH] Given dirty tracked files and no new remote commits, then pull discards local edits', async () => {
      await writeFile(path.join(cloneDir, 'README.md'), '# local edit\n')

      const hadNewCommits = await pullRepo(cloneDir)

      expect(hadNewCommits).toBe(false)
      expect(await readFile(path.join(cloneDir, 'README.md'), 'utf8')).toBe('# v1\n')
    })

    it('[TC-9YYO] Given dirty tracked files and new remote commits, then pull succeeds', async () => {
      await writeFile(path.join(cloneDir, 'README.md'), '# local edit\n')

      const seedDir = path.join(tmpRoot, 'seed')
      await writeFile(path.join(seedDir, 'README.md'), '# v2\n')
      await git(seedDir, 'add', '.')
      await git(seedDir, 'commit', '-m', 'v2')
      await git(seedDir, 'push', 'origin', 'main')

      const hadNewCommits = await pullRepo(cloneDir)

      expect(hadNewCommits).toBe(true)
      expect(await readFile(path.join(cloneDir, 'README.md'), 'utf8')).toBe('# v2\n')
    })
  })

  describe('isAncestorOfHead / resetToSha (snapshot reconcile)', () => {
    let tmpRoot: string
    let repo: string
    let firstSha: string
    let secondSha: string

    async function git(cwd: string, ...args: string[]): Promise<string> {
      const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
      return stdout.trim()
    }

    beforeEach(async () => {
      tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-git-sync-reconcile-'))
      repo = path.join(tmpRoot, 'repo')
      await mkdir(repo, { recursive: true })
      await git(repo, 'init', '-b', 'main')
      await git(repo, 'config', 'user.email', 'test@test.com')
      await git(repo, 'config', 'user.name', 'Test')
      await git(repo, 'config', 'commit.gpgsign', 'false')
      await writeFile(path.join(repo, 'f.txt'), 'v1\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-m', 'v1')
      firstSha = await git(repo, 'rev-parse', 'HEAD')
      await writeFile(path.join(repo, 'f.txt'), 'v2\n')
      await git(repo, 'commit', '-am', 'v2')
      secondSha = await git(repo, 'rev-parse', 'HEAD')
    })

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true })
    })

    it('reports an earlier commit as an ancestor of HEAD (linear history)', async () => {
      expect(await isAncestorOfHead(repo, firstSha)).toBe(true)
      expect(await isAncestorOfHead(repo, secondSha)).toBe(true) // a commit is its own ancestor
    })

    it('reports an unknown / diverged commit as not an ancestor', async () => {
      expect(await isAncestorOfHead(repo, 'f'.repeat(40))).toBe(false)
    })

    it('resetToSha aligns the working tree to the built commit', async () => {
      await resetToSha(repo, firstSha)
      expect(await getHeadSha(repo)).toBe(firstSha)
      expect(await readFile(path.join(repo, 'f.txt'), 'utf8')).toBe('v1\n')
    })
  })

  describe('cloneRepo default branch', () => {
    let tmpRoot: string
    let origin: string

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    }

    // Build a repo whose default branch is `master` (not `main`) — the raylib/raygui case.
    beforeEach(async () => {
      tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-git-sync-clone-'))
      origin = path.join(tmpRoot, 'origin')
      await mkdir(origin, { recursive: true })
      await git(origin, 'init', '-b', 'master')
      await git(origin, 'config', 'user.email', 'test@test.com')
      await git(origin, 'config', 'user.name', 'Test')
      await git(origin, 'config', 'commit.gpgsign', 'false')
      await writeFile(path.join(origin, 'README.md'), '# master repo\n')
      await git(origin, 'add', '.')
      await git(origin, 'commit', '-m', 'init')
    })

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true })
    })

    it('[TC-VPTT] clones a repo whose default branch is master without specifying a branch', async () => {
      const dest = path.join(tmpRoot, 'clone-default')
      await cloneRepo(origin, dest)
      expect(await getCurrentBranch(dest)).toBe('master')
      expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# master repo\n')
    })

    it('[TC-YCUC] honors an explicitly requested branch', async () => {
      await git(origin, 'checkout', '-b', 'dev')
      await writeFile(path.join(origin, 'README.md'), '# dev branch\n')
      await git(origin, 'commit', '-am', 'dev')
      await git(origin, 'checkout', 'master')

      const dest = path.join(tmpRoot, 'clone-dev')
      await cloneRepo(origin, dest, 'dev')
      expect(await getCurrentBranch(dest)).toBe('dev')
    })

    it('[TC-UIFR] clones a shallow local snapshot without blob:none filter stall', async () => {
      const shallowSrc = path.join(tmpRoot, 'shallow-src')
      await git(tmpRoot, 'clone', '--depth', '1', origin, shallowSrc)
      const dest = path.join(tmpRoot, 'shallow-dest')
      const started = Date.now()
      await cloneRepo(shallowSrc, dest)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(await getCurrentBranch(dest)).toBe('master')
      expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# master repo\n')
    })
  })
})
