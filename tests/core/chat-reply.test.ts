import { describe, expect, it } from 'vitest'
import { gitRemoteToBrowseUrl } from '@kb/core/ops/git-sync.js'
import {
  chatSourceReposFromBaseRepos,
  formatChatReply,
  formatChatSourcesFooter,
  normalizeChatSources,
  resolveChatSourceDisplay,
} from '@kb/core/service/chat-reply.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'

const kbRepo = {
  slug: 'rosenjcb-kb',
  browseUrl: 'https://github.com/rosenjcb/kb',
  branch: 'main',
}

const raylibRepo = {
  slug: 'raysan5-raylib',
  browseUrl: 'https://github.com/raysan5/raylib',
  branch: 'master',
}

describe('gitRemoteToBrowseUrl', () => {
  it('[TC-7] maps https and ssh remotes to browse roots; rejects local paths', () => {
    expect(gitRemoteToBrowseUrl('https://github.com/rosenjcb/kb.git')).toBe(
      'https://github.com/rosenjcb/kb',
    )
    expect(gitRemoteToBrowseUrl('git@github.com:rosenjcb/kb.git')).toBe(
      'https://github.com/rosenjcb/kb',
    )
    expect(gitRemoteToBrowseUrl('ssh://git@gitlab.com/org/repo.git')).toBe(
      'https://gitlab.com/org/repo',
    )
    expect(gitRemoteToBrowseUrl('/tmp/local-clone')).toBeNull()
    expect(gitRemoteToBrowseUrl('file:///tmp/local-clone')).toBeNull()
  })
})

describe('chatSourceReposFromBaseRepos', () => {
  it('[TC-7] keeps only browsable remotes with a real branch name', () => {
    const repos: BaseRepo[] = [
      {
        gitUrl: 'https://github.com/rosenjcb/kb.git',
        gitBranch: 'main',
        slug: 'rosenjcb-kb',
        dir: 'repos/rosenjcb-kb',
      },
      {
        gitUrl: '/tmp/local',
        gitBranch: 'main',
        slug: 'local-repo',
        dir: 'repos/local-repo',
      },
      {
        gitUrl: 'https://github.com/acme/x.git',
        gitBranch: 'HEAD',
        slug: 'acme-x',
        dir: 'repos/acme-x',
      },
    ]
    expect(chatSourceReposFromBaseRepos(repos)).toEqual([kbRepo])
  })
})

describe('resolveChatSourceDisplay / normalizeChatSources', () => {
  it('[TC-1] keeps fact:// ids and drops other schemes', () => {
    expect(
      resolveChatSourceDisplay({ filePath: 'fact://abc123' }, [kbRepo])?.label,
    ).toBe('fact://abc123')
    expect(resolveChatSourceDisplay({ filePath: 'https://example.com/x' }, [kbRepo])).toBeNull()
  })

  it('[TC-2] dedupes and builds per-repo blob hrefs from the registry', () => {
    const out = normalizeChatSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/src/tools/x.ts', gitRepo: 'rosenjcb-kb', symbol: 'foo' },
        { filePath: 'fact://deadbeef' },
      ],
      { sourceRepos: [kbRepo] },
    )
    expect(out).toEqual([
      {
        label: 'packages/kb-core/src/core/CHAT.md',
        href: 'https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md',
      },
      {
        label: 'src/tools/x.ts',
        href: 'https://github.com/rosenjcb/kb/blob/main/src/tools/x.ts',
        symbol: 'foo',
      },
      { label: 'fact://deadbeef' },
    ])
  })

  it('[TC-8] multi-repo: each slug uses its own browse URL and primary branch', () => {
    const out = normalizeChatSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'raysan5-raylib/src/raudio.c', gitRepo: 'raysan5-raylib' },
      ],
      { sourceRepos: [kbRepo, raylibRepo] },
    )
    expect(out).toEqual([
      {
        label: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md',
        href: 'https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md',
      },
      {
        label: 'raysan5-raylib/src/raudio.c',
        href: 'https://github.com/raysan5/raylib/blob/master/src/raudio.c',
      },
    ])
  })

  it('[TC-8] unknown slug keeps a path label without href', () => {
    const out = normalizeChatSources(
      [{ filePath: 'other-slug/README.md', gitRepo: 'other-slug' }],
      { sourceRepos: [kbRepo] },
    )
    expect(out).toEqual([{ label: 'other-slug/README.md' }])
  })
})

describe('formatChatReply', () => {
  it('[TC-3] appends a plain Sources footer', () => {
    const text = formatChatReply(
      'Hello.',
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
      ],
      { sourceRepos: [kbRepo] },
    )
    expect(text).toBe(
      [
        'Hello.',
        '',
        'Sources',
        '1. [packages/kb-core/src/core/CHAT.md](https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md)',
      ].join('\n'),
    )
  })

  it('[TC-4] formats Slack mrkdwn with per-repo clickable links', () => {
    const text = formatChatReply(
      'Hello.',
      [{ filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' }],
      {
        flavor: 'slack',
        sourceRepos: [kbRepo],
      },
    )
    expect(text).toContain('*Sources*')
    expect(text).toContain(
      '<https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md|packages/kb-core/src/core/CHAT.md>',
    )
  })

  it('[TC-3] returns answer alone when sources are empty', () => {
    expect(formatChatReply('Just text.', [])).toBe('Just text.')
    expect(formatChatSourcesFooter([])).toBe('')
  })
})
