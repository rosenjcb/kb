import { gitRemoteToBrowseUrl } from '@kb/core/ops/git-sync.js'
import {
  chatSourceReposFromBaseRepos,
  resolveChatSourceDisplay,
} from '@kb/core/service/chat-reply.js'
import {
  formatGroupedChatReply,
  formatGroupedSourcesFooter,
  groupSources,
} from '@kb/core/service/source-grouping.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'
import { describe, expect, it } from 'vitest'

const kbRepo = {
  slug: 'rosenjcb-kb',
  browseUrl: 'https://github.com/rosenjcb/kb',
  branch: 'main',
  repoId: 'rosenjcb/kb',
}

const raylibRepo = {
  slug: 'raysan5-raylib',
  browseUrl: 'https://github.com/raysan5/raylib',
  branch: 'master',
  repoId: 'raysan5/raylib',
}

describe('gitRemoteToBrowseUrl', () => {
  it('[TC-7FWQ] maps https and ssh remotes to browse roots; rejects local paths', () => {
    expect(gitRemoteToBrowseUrl('https://github.com/rosenjcb/kb.git')).toBe(
      'https://github.com/rosenjcb/kb'
    )
    expect(gitRemoteToBrowseUrl('git@github.com:rosenjcb/kb.git')).toBe(
      'https://github.com/rosenjcb/kb'
    )
    expect(gitRemoteToBrowseUrl('ssh://git@gitlab.com/org/repo.git')).toBe(
      'https://gitlab.com/org/repo'
    )
    expect(gitRemoteToBrowseUrl('/tmp/local-clone')).toBeNull()
    expect(gitRemoteToBrowseUrl('file:///tmp/local-clone')).toBeNull()
  })
})

describe('chatSourceReposFromBaseRepos', () => {
  it('[TC-7FWQ] keeps browsable remotes; a bare HEAD clone still links via HEAD', () => {
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
    // Local remote (no browse URL) is dropped; the bare-HEAD clone is kept and
    // links against `HEAD`, which the forge resolves to its default branch.
    expect(chatSourceReposFromBaseRepos(repos)).toEqual([
      kbRepo,
      { slug: 'acme-x', browseUrl: 'https://github.com/acme/x', branch: 'HEAD', repoId: 'acme/x' },
    ])
  })
})

describe('resolveChatSourceDisplay', () => {
  it('[TC-4P8G] keeps fact:// ids and drops other schemes', () => {
    expect(resolveChatSourceDisplay({ filePath: 'fact://abc123' }, [kbRepo])?.label).toBe(
      'fact://abc123'
    )
    expect(resolveChatSourceDisplay({ filePath: 'https://example.com/x' }, [kbRepo])).toBeNull()
  })
})

describe('groupSources', () => {
  it('[TC-03Q7] dedupes by file, folds symbols, builds hrefs, drops fact:// ids', () => {
    const out = groupSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/src/tools/x.ts', gitRepo: 'rosenjcb-kb', symbol: 'foo' },
        { filePath: 'fact://deadbeef' },
      ],
      { sourceRepos: [kbRepo] }
    )
    expect(
      out.map(g => ({
        path: g.path,
        repo: g.repo,
        relPath: g.relPath,
        href: g.href,
        symbols: g.symbols,
      }))
    ).toEqual([
      {
        path: 'rosenjcb/kb/packages/kb-core/src/core/CHAT.md',
        repo: 'rosenjcb/kb',
        relPath: 'packages/kb-core/src/core/CHAT.md',
        href: 'https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md',
        symbols: [],
      },
      {
        path: 'rosenjcb/kb/src/tools/x.ts',
        repo: 'rosenjcb/kb',
        relPath: 'src/tools/x.ts',
        href: 'https://github.com/rosenjcb/kb/blob/main/src/tools/x.ts',
        symbols: ['foo'],
      },
    ])
    // The two identical CHAT.md facts collapse to one file with a fact count of 2.
    expect(out[0].factCount).toBe(2)
  })

  it('[TC-B7JK] caps the file list at maxSources but still folds later facts', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ filePath: `src/f${i}.ts` }))
    // A repeat of an already-cited file must not be dropped by the cap.
    sources.push({ filePath: 'src/f0.ts' })
    const out = groupSources(sources, { maxSources: 3 })
    expect(out.map(g => g.path)).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts'])
    expect(out[0].factCount).toBe(2)
  })

  it('[TC-TULY] multi-repo: each path is qualified by public repo id, not the clone dir', () => {
    const out = groupSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'raysan5-raylib/src/raudio.c', gitRepo: 'raysan5-raylib' },
      ],
      { sourceRepos: [kbRepo, raylibRepo] }
    )
    expect(
      out.map(g => ({ path: g.path, repo: g.repo, relPath: g.relPath, href: g.href }))
    ).toEqual([
      {
        path: 'rosenjcb/kb/packages/kb-core/src/core/CHAT.md',
        repo: 'rosenjcb/kb',
        relPath: 'packages/kb-core/src/core/CHAT.md',
        href: 'https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md',
      },
      {
        path: 'raysan5/raylib/src/raudio.c',
        repo: 'raysan5/raylib',
        relPath: 'src/raudio.c',
        href: 'https://github.com/raysan5/raylib/blob/master/src/raudio.c',
      },
    ])
  })

  it('[TC-TULY] an unregistered clone still yields a repo-relative path, without href', () => {
    const out = groupSources([{ filePath: 'other-slug/README.md', gitRepo: 'other-slug' }], {
      sourceRepos: [kbRepo],
    })
    expect(
      out.map(g => ({ path: g.path, repo: g.repo, relPath: g.relPath, href: g.href }))
    ).toEqual([{ path: 'README.md', repo: undefined, relPath: 'README.md', href: undefined }])
  })

  it('[TC-N3WQ] no citation path ever contains a local clone dir name', () => {
    // The regression this guards: a serve-only node (or a surface that forgot the
    // registry) rendered `kb-2026-08-15-1419-kb/packages/…` — a local provisioning
    // artifact — as the file a user was told to open.
    const cloneSlug = 'kb-2026-08-15-1419-kb'
    const facts = [
      { filePath: `${cloneSlug}/packages/kb-core/src/core/CHAT.md`, gitRepo: cloneSlug },
    ]
    for (const sourceRepos of [[], [kbRepo], [kbRepo, raylibRepo]]) {
      for (const g of groupSources(facts, { sourceRepos })) {
        expect(g.path).not.toContain(cloneSlug)
        expect(g.relPath).toBe('packages/kb-core/src/core/CHAT.md')
      }
    }
  })
})

describe('formatGroupedChatReply', () => {
  it('[TC-NL7F] appends a plain Sources footer', () => {
    const grouped = groupSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' },
      ],
      { sourceRepos: [kbRepo] }
    )
    expect(formatGroupedChatReply('Hello.', grouped)).toBe(
      [
        'Hello.',
        '',
        'Sources',
        '1. [rosenjcb/kb/packages/kb-core/src/core/CHAT.md](https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md)',
      ].join('\n')
    )
  })

  it('[TC-AZBG] formats Slack mrkdwn with per-repo clickable links', () => {
    const grouped = groupSources(
      [{ filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' }],
      { sourceRepos: [kbRepo] }
    )
    const text = formatGroupedChatReply('Hello.', grouped, 'slack')
    expect(text).toContain('*Sources*')
    expect(text).toContain(
      '<https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md|rosenjcb/kb/packages/kb-core/src/core/CHAT.md>'
    )
  })

  it('[TC-NL7F] returns answer alone when sources are empty', () => {
    expect(formatGroupedChatReply('Just text.', [])).toBe('Just text.')
    expect(formatGroupedSourcesFooter([])).toBe('')
  })

  it('[TC-ENTF] appends a Routes / services section when entities are present', () => {
    const grouped = groupSources(
      [{ filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' }],
      { sourceRepos: [kbRepo] }
    )
    const text = formatGroupedChatReply('Hello.', grouped, 'plain', [
      { kind: 'api', name: '/v1/query', role: 'scope' },
    ])
    expect(text).toContain('**Routes / services**')
    expect(text).toContain('api /v1/query')
    const slack = formatGroupedChatReply('Hello.', grouped, 'slack', [
      { kind: 'service', name: 'kb-server', role: 'cited' },
    ])
    expect(slack).toContain('*Routes / services*')
    expect(slack).toContain('service kb-server')
  })
})
