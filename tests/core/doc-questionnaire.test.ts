import { describe, expect, it } from 'vitest'
import { loadQuestionnaire } from '@kb/core/core/doc-questionnaire.js'
import { DOC_TYPES } from '@kb/core/core/doc-taxonomy.js'

describe('loadQuestionnaire', () => {
  it.each(DOC_TYPES)('[TC-181] Given DocType %s, then loads non-empty keys and questions', docType => {
    const items = loadQuestionnaire(docType)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.key.length).toBeGreaterThan(0)
      expect(item.question.length).toBeGreaterThan(0)
    }
  })
})
