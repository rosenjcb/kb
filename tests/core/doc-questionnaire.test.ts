import { describe, expect, it } from 'vitest'
import { loadQuestionnaire, parseDocTypeFlag } from '../../src/core/doc-questionnaire'
import { DOC_TYPES } from '../../src/core/doc-taxonomy'

describe('loadQuestionnaire', () => {
  it.each(DOC_TYPES)('Given DocType %s, then loads non-empty keys and questions', docType => {
    const items = loadQuestionnaire(docType)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.key.length).toBeGreaterThan(0)
      expect(item.question.length).toBeGreaterThan(0)
    }
  })
})

describe('parseDocTypeFlag', () => {
  it('Given valid type, then returns DocType', () => {
    expect(parseDocTypeFlag('  reference  ')).toBe('reference')
  })

  it('Given invalid type, then throws', () => {
    expect(() => parseDocTypeFlag('architecture')).toThrow('Invalid --type')
  })
})
