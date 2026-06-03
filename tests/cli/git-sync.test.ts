import { describe, expect, it } from 'vitest'
import { baseNameFromGitUrl } from '../../src/cli/git-sync'

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
})
