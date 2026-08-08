import { describe, expect, it } from 'vitest'
import {
  inlineMarkdownToSlack,
  markdownToSlackMrkdwn,
} from '@kb/core/service/markdown-to-slack.js'
import { formatGroupedChatReply, groupSources } from '@kb/core/service/source-grouping.js'

describe('inlineMarkdownToSlack', () => {
  it('[TC-5] maps bold, links, and code to Slack mrkdwn', () => {
    expect(inlineMarkdownToSlack('see **bold** and `code`')).toBe('see *bold* and `code`')
    expect(inlineMarkdownToSlack('[docs](https://example.com/a)')).toBe(
      '<https://example.com/a|docs>',
    )
  })
})

describe('markdownToSlackMrkdwn', () => {
  it('[TC-5] turns ATX headers into bold lines', () => {
    expect(markdownToSlackMrkdwn('### Key Differences\n\nHello.')).toBe(
      '*Key Differences*\n\nHello.',
    )
  })

  it('[TC-5] rewrites GFM tables into ·-separated rows', () => {
    const md = [
      '| Feature | kb query | kb chat |',
      '| :--- | :--- | :--- |',
      '| Path | one-shot | multi-turn |',
      '| Tools | none | query_kb |',
    ].join('\n')
    const out = markdownToSlackMrkdwn(md)
    expect(out).toContain('*Feature*  ·  *kb query*  ·  *kb chat*')
    expect(out).toContain('one-shot  ·  multi-turn')
    expect(out).not.toContain('| :---')
  })

  it('[TC-5] preserves fenced code and converts surrounding markdown', () => {
    const out = markdownToSlackMrkdwn('### Install\n\n```\nnpm i lua\n```\n\nUse **wasm**.')
    expect(out).toContain('*Install*')
    expect(out).toContain('```\nnpm i lua\n```')
    expect(out).toContain('Use *wasm*.')
  })

  it('[TC-5] formats lists with Slack bullets', () => {
    const out = markdownToSlackMrkdwn('- one\n- two\n\n1. a\n2. b')
    expect(out).toContain('• one')
    expect(out).toContain('• two')
    expect(out).toContain('1. a')
    expect(out).toContain('2. b')
  })
})

describe('formatGroupedChatReply slack flavor', () => {
  it('[TC-6] converts the answer body to mrkdwn before appending Sources', () => {
    const grouped = groupSources(
      [{ filePath: 'rosenjcb-kb/packages/kb-core/src/core/CHAT.md', gitRepo: 'rosenjcb-kb' }],
      {
        sourceRepos: [
          {
            slug: 'rosenjcb-kb',
            browseUrl: 'https://github.com/rosenjcb/kb',
            branch: 'main',
          },
        ],
      },
    )
    const text = formatGroupedChatReply('### Overview\n\n**Chat** uses tools.', grouped, 'slack')
    expect(text).toContain('*Overview*')
    expect(text).toContain('*Chat* uses tools.')
    expect(text).toContain('*Sources*')
    expect(text).toContain(
      '<https://github.com/rosenjcb/kb/blob/main/packages/kb-core/src/core/CHAT.md|packages/kb-core/src/core/CHAT.md>',
    )
    expect(text).not.toContain('###')
    expect(text).not.toContain('**Chat**')
  })
})
