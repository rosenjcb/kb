import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  promptsRootDir,
  readPromptAssetUtf8,
  resolvePromptPath,
} from '../../src/prompts/prompt-assets'

describe('prompt-assets', () => {
  it('[TC-9] resolvePromptPath nests under prompts root', () => {
    expect(resolvePromptPath('doc-questionnaires', 'introduction.md')).toBe(
      join(promptsRootDir, 'doc-questionnaires', 'introduction.md')
    )
  })

  it('[TC-10] readPromptAssetUtf8 reads questionnaire file', () => {
    const raw = readPromptAssetUtf8('doc-questionnaires', 'introduction.md')
    expect(raw).toContain('oneLineThesis')
  })
})
