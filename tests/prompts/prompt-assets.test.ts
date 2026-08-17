import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  promptsRootDir,
  readPromptAssetUtf8,
  resolvePromptPath,
} from '@kb/core/prompts/prompt-assets.js'

describe('prompt-assets', () => {
  it('[TC-X8XU] resolvePromptPath nests under prompts root', () => {
    expect(resolvePromptPath('sub', 'init-refinement.md')).toBe(
      join(promptsRootDir, 'sub', 'init-refinement.md')
    )
  })

  it('[TC-32W5] readPromptAssetUtf8 reads a prompt asset file', () => {
    const raw = readPromptAssetUtf8('init-refinement.md')
    expect(raw).toContain('refining a KB document set')
  })
})
