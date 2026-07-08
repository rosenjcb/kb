import { describe, expect, it } from 'vitest'
import {
  PROCEDURAL_SYNTHESIS_GUIDANCE,
  isProceduralQuestion,
} from '@kb/core/query/procedural-intent.js'

describe('isProceduralQuestion', () => {
  it('matches how-to / step-by-step phrasings', () => {
    const procedural = [
      'How do I install and build raylib, including dependencies and build systems?',
      'How do I set up a new default widget in a producer dashboard?',
      'What are the steps to configure the graphics backend?',
      'Walk me through the kb init flow',
      'In what order does the query orchestrator run its passes?',
      'What is the workflow for publishing docs?',
      'How to add a new intent',
      'Getting started with the eval harness',
    ]
    for (const q of procedural) {
      expect(isProceduralQuestion(q), q).toBe(true)
    }
  })

  it('does not match plain factual / definitional questions', () => {
    const nonProcedural = [
      'What is raylib for, and what are its main capabilities?',
      'What are the coding conventions for contributing to raylib?',
      'Which file defines the fact curator?',
      'What does directDownlineDataAccess control?',
      '',
    ]
    for (const q of nonProcedural) {
      expect(isProceduralQuestion(q), q).toBe(false)
    }
  })

  it('exposes non-empty ordering guidance for wiring into synthesis prompts', () => {
    expect(PROCEDURAL_SYNTHESIS_GUIDANCE).toContain('ordered')
    expect(PROCEDURAL_SYNTHESIS_GUIDANCE.length).toBeGreaterThan(200)
  })
})
