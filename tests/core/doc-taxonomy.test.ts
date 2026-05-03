import { describe, expect, it } from 'vitest'
import {
  DOC_TYPES,
  type DocType,
  LEGACY_DOC_TYPE_REMAP,
  coerceDocType,
  isDocType,
} from '../../src/core/doc-taxonomy'

describe('DOC_TYPES enum', () => {
  it('Given the canonical list, then contains exactly five members', () => {
    expect(DOC_TYPES).toEqual(['howto', 'introduction', 'reference', 'decision', 'runbook'])
  })

  it('Given a known DocType, then isDocType returns true', () => {
    for (const value of DOC_TYPES) {
      expect(isDocType(value)).toBe(true)
    }
  })

  it('Given a legacy or unknown value, then isDocType returns false', () => {
    expect(isDocType('architecture')).toBe(false)
    expect(isDocType('checklist')).toBe(false)
    expect(isDocType('nonsense')).toBe(false)
    expect(isDocType(null)).toBe(false)
    expect(isDocType(undefined)).toBe(false)
    expect(isDocType(42)).toBe(false)
  })
})

describe('LEGACY_DOC_TYPE_REMAP', () => {
  it('Given the legacy keys, then maps each to a current DocType', () => {
    expect(LEGACY_DOC_TYPE_REMAP).toEqual({
      architecture: 'reference',
      checklist: 'runbook',
    })

    for (const value of Object.values(LEGACY_DOC_TYPE_REMAP)) {
      expect(isDocType(value)).toBe(true)
    }
  })
})

describe('coerceDocType', () => {
  it('Given a current DocType, then returns it unchanged', () => {
    for (const value of DOC_TYPES) {
      expect(coerceDocType(value)).toBe(value)
    }
  })

  it('Given a legacy DocType, then returns the remapped value', () => {
    expect(coerceDocType('architecture')).toBe<DocType>('reference')
    expect(coerceDocType('checklist')).toBe<DocType>('runbook')
  })

  it('Given an unknown or non-string value, then returns undefined', () => {
    expect(coerceDocType('mystery-type')).toBeUndefined()
    expect(coerceDocType('')).toBeUndefined()
    expect(coerceDocType(null)).toBeUndefined()
    expect(coerceDocType(undefined)).toBeUndefined()
    expect(coerceDocType(42)).toBeUndefined()
  })
})
