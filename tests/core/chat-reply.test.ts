import { describe, expect, it } from 'vitest'
import {
  formatChatReply,
  formatChatSourcesFooter,
  normalizeChatSources,
  repoRelativeSourcePath,
} from '@kb/core/service/chat-reply.js'

describe('repoRelativeSourcePath', () => {
  it('[TC-1] strips indexed git-repo prefixes', () => {
    expect(repoRelativeSourcePath('rosenjcb-kb/packages/kb-core/src/core/CHAT.md')).toBe(
      'packages/kb-core/src/core/CHAT.md',
    )
    expect(repoRelativeSourcePath('kb/TESTING.md')).toBe('TESTING.md')
  })

  it('[TC-1] keeps fact:// ids and drops other schemes', () => {
    expect(repoRelativeSourcePath('fact://abc123')).toBe('fact://abc123')
    expect(repoRelativeSourcePath('https://example.com/x')).toBeNull()
  })
})

describe('normalizeChatSources', () => {
  it('[TC-2] dedupes by path (+ symbol) and builds blob hrefs when repo is set', () => {
    const out = normalizeChatSources(
      [
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md' },
        { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md' },
        { filePath: 'rosenjcb-kb/src/tools/x.ts', symbol: 'foo' },
        { filePath: 'fact://deadbeef' },
      ],
      {
        sourceRepoUrl: 'https://github.com/rosenjcb/kb',
        sourceBranch: 'main',
      },
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
})

describe('formatChatReply', () => {
  it('[TC-3] appends a plain Sources footer', () => {
    const text = formatChatReply('Hello.', [
      { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md' },
      { filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md' },
    ])
    expect(text).toBe(
      ['Hello.', '', 'Sources', '1. packages/kb-core/src/core/CHAT.md'].join('\n'),
    )
  })

  it('[TC-4] formats Slack mrkdwn with optional clickable links', () => {
    const text = formatChatReply(
      'Hello.',
      [{ filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md' }],
      {
        flavor: 'slack',
        sourceRepoUrl: 'https://github.com/rosenjcb/kb',
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
