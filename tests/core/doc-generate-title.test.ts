import { describe, expect, it } from 'vitest'
import type { DocGenerateSession } from '@kb/core/core/doc-generate-session.js'
import { deriveDocumentTitle, squeezeKbDocumentTitle } from '@kb/core/core/doc-generate-title.js'

function minimalSession(answers: DocGenerateSession['answers'], prompt = 'p'): DocGenerateSession {
  return {
    id: 's',
    prompt,
    docType: 'introduction',
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
    answers,
  }
}

describe('squeezeKbDocumentTitle', () => {
  it('[TC-30] strips trailing sentence punctuation', () => {
    expect(squeezeKbDocumentTitle('KB overview for developers.')).toBe('KB overview for developers')
  })

  it('[TC-31] truncates long run-on sentences by word and char caps', () => {
    const long =
      'Reader can create or refresh a project KB base from existing markdown so kb query and agents return grounded answers for that repository and beyond.'
    const out = squeezeKbDocumentTitle(long)
    expect(out.length).toBeLessThanOrEqual(72)
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(10)
    expect(out.endsWith('.')).toBe(false)
  })

  it('[TC-32] uses first line only', () => {
    expect(squeezeKbDocumentTitle('Short title\nMore stuff')).toBe('Short title')
  })
})

describe('deriveDocumentTitle', () => {
  it('[TC-33] prefers documentTitle over oneLineThesis', () => {
    const t = deriveDocumentTitle(
      minimalSession([
        { key: 'documentTitle', question: '', answer: 'KB overview for AI-assisted development' },
        {
          key: 'oneLineThesis',
          question: '',
          answer: 'This is a very long thesis that would be bad as a title.',
        },
      ])
    )
    expect(t).toBe('KB overview for AI-assisted development')
  })

  it('[TC-34] falls back to squeezed thesis when documentTitle missing', () => {
    const t = deriveDocumentTitle(
      minimalSession([
        {
          key: 'oneLineThesis',
          question: '',
          answer: 'Local-first KB for grounded agent context.',
        },
      ])
    )
    expect(t).toBe('Local-first KB for grounded agent context')
  })
})
