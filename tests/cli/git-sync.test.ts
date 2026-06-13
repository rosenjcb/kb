import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseNameFromGitUrl, pullRepo } from '../../src/cli/git-sync'

const execFileAsync = promisify(execFile)

describe('git-sync', () => {
  describe('baseNameFromGitUrl', () => {
    it('derives name from https URL with .git suffix', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo.git')).toBe('org-repo')
    })

    it('derives name from https URL without .git suffix', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo')).toBe('org-repo')
    })

    it('derives name from https URL with trailing slash', () => {
      expect(baseNameFromGitUrl('https://github.com/org/repo/')).toBe('org-repo')
    })

    it('derives name from ssh URL', () => {
      expect(baseNameFromGitUrl('git@github.com:org/repo.git')).toBe('org-repo')
    })

    it('lowercases the result', () => {
      expect(baseNameFromGitUrl('https://github.com/MyOrg/MyRepo')).toBe('myorg-myrepo')
    })

    it('replaces special characters (but keeps underscore, dot, dash) with dashes', () => {
      // underscore and dot are allowed; spaces/colons would be replaced
      expect(baseNameFromGitUrl('https://github.com/my_org/my.repo')).toBe('my_org-my.repo')
    })
  })

  describe('pullRepo', () => {
    let tmpRoot: string
    let bareOrigin: string
    let cloneDir: string

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    }

    beforeEach(async () => {
      tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-git-sync-pull-'))
      bareOrigin = path.join(tmpRoot, 'origin.git')
      cloneDir = path.join(tmpRoot, 'clone')

      await git(tmpRoot, 'init', '--bare', bareOrigin)

      const seedDir = path.join(tmpRoot, 'seed')
      await mkdir(seedDir, { recursive: true })
      await git(seedDir, 'init')
      await git(seedDir, 'config', 'user.email', 'test@test.com')
      await git(seedDir, 'config', 'user.name', 'Test')
      await git(seedDir, 'config', 'commit.gpgsign', 'false')
      await writeFile(path.join(seedDir, 'README.md'), '# v1\n')
      await writeFile(path.join(seedDir, '.kb'), 'kb\n')
      await git(seedDir, 'add', '.')
      await git(seedDir, 'commit', '-m', 'v1')
      await git(seedDir, 'branch', '-M', 'main')
      await git(seedDir, 'remote', 'add', 'origin', bareOrigin)
      await git(seedDir, 'push', '-u', 'origin', 'main')

      await git(tmpRoot, 'clone', bareOrigin, cloneDir)
      await git(cloneDir, 'config', 'user.email', 'test@test.com')
      await git(cloneDir, 'config', 'user.name', 'Test')
      await git(cloneDir, 'config', 'commit.gpgsign', 'false')
    })

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true })
    })

    it('Given a dirty .kb marker in the clone, then pull succeeds', async () => {
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
  })
})
