import {
  assessQueryEvidence,
  assessResultCount,
  assessRetrievalEvidence,
  isEvidenceAtLeast,
  parseEvidenceLabel,
} from '@kb/core/core/evidence-label.js'
import { describe, expect, it } from 'vitest'

/**
 * The float these labels replaced fed two live gates: chat refused a turn below
 * 0.45, and the MCP serializer attached a verify note below 0.7. Turning the
 * float into a category must not move either line — a representation change that
 * silently answers (or refuses) different questions is a behavior change wearing
 * a refactor's clothes. These pin both boundaries against the original formula.
 */
function legacyConfidence(uniqueFacts: number, avgTop: number, conceptCoverage: number): number {
  const blended = avgTop * 0.75 + conceptCoverage * 0.25
  const floor = uniqueFacts > 0 && avgTop >= 0.65 ? Math.min(0.6, avgTop) : 0
  return Math.min(1, Math.max(0, Math.max(blended, floor)))
}

describe('evidence labels', () => {
  it('[TC-36] Given the metric space, then the chat refusal gate matches the pre-label boundary', () => {
    let mismatches = 0
    for (let avgTop = 0; avgTop <= 1.0001; avgTop += 0.01) {
      for (let coverage = 0; coverage <= 1.0001; coverage += 0.01) {
        const legacyAnswers = legacyConfidence(20, avgTop, coverage) >= 0.45
        const labelAnswers = isEvidenceAtLeast(
          assessRetrievalEvidence({ uniqueFacts: 20, avgTop, conceptCoverage: coverage }),
          'moderate'
        )
        if (legacyAnswers !== labelAnswers) mismatches += 1
      }
    }
    expect(mismatches).toBe(0)
  })

  it('[TC-36] Given the metric space, then the MCP verify note matches the pre-label boundary', () => {
    let mismatches = 0
    for (let avgTop = 0; avgTop <= 1.0001; avgTop += 0.01) {
      for (let coverage = 0; coverage <= 1.0001; coverage += 0.01) {
        const legacyClean = legacyConfidence(20, avgTop, coverage) >= 0.7
        const labelClean = isEvidenceAtLeast(
          assessRetrievalEvidence({ uniqueFacts: 20, avgTop, conceptCoverage: coverage }),
          'strong'
        )
        if (legacyClean !== labelClean) mismatches += 1
      }
    }
    expect(mismatches).toBe(0)
  })

  it('[TC-36] Given no facts, then evidence is none regardless of other metrics', () => {
    expect(assessRetrievalEvidence({ uniqueFacts: 0, avgTop: 0.9, conceptCoverage: 1 })).toBe(
      'none'
    )
  })

  it('[TC-36] Given result counts, then labels are ordered and comparable', () => {
    expect(assessResultCount(0)).toBe('none')
    expect(assessResultCount(3)).toBe('strong')
    expect(isEvidenceAtLeast('moderate', 'weak')).toBe(true)
    expect(isEvidenceAtLeast('weak', 'moderate')).toBe(false)
  })

  it('[TC-36] Given an unparseable configured floor, then the default is used', () => {
    // A leftover numeric value from the float era must not disable a gate.
    expect(parseEvidenceLabel('0.45', 'moderate')).toBe('moderate')
    expect(parseEvidenceLabel(undefined, 'moderate')).toBe('moderate')
    expect(parseEvidenceLabel('STRONG', 'moderate')).toBe('strong')
  })

  it('[TC-NZR6] Given three results and no relevance metrics, then evidence is moderate not strong', () => {
    expect(assessQueryEvidence({ uniqueFacts: 3 })).toBe('moderate')
    expect(assessQueryEvidence({ uniqueFacts: 0 })).toBe('none')
    expect(assessQueryEvidence({ uniqueFacts: 1 })).toBe('weak')
  })

  it('[TC-AX6M] Given a landing whose linked facts were not retrieved, then evidence is weak', () => {
    expect(
      assessQueryEvidence({
        uniqueFacts: 8,
        avgTop: 0.9,
        conceptCoverage: 1,
        routing: { landed: true, linkedCount: 4, retrievedLinkedCount: 0 },
      })
    ).toBe('weak')
  })
})
