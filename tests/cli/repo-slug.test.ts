import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoDirForSlug, repoSlugFromGitUrl } from '@kb/core/storage/repo-slug.js'

describe('repo-slug', () => {
  it('[TC-18] repoSlugFromGitUrl handles https, ssh, and local paths', () => {
    expect(repoSlugFromGitUrl('https://github.com/Acme/Auth-Svc.git')).toBe('acme-auth-svc')
    expect(repoSlugFromGitUrl('git@github.com:Acme/web.git')).toBe('acme-web')
    expect(repoSlugFromGitUrl('/tmp/fixtures/my-service')).toBe('fixtures-my-service')
  })

  it('[TC-19] repoDirForSlug nests clones under repos/', () => {
    expect(repoDirForSlug('org-repo')).toBe(path.join('repos', 'org-repo'))
  })
})
