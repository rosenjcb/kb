import {
  PROCEDURAL_SYNTHESIS_GUIDANCE,
  isProceduralQuestion,
} from '@kb/core/query/procedural-intent.js'
import { describe, expect, it } from 'vitest'

describe('isProceduralQuestion', () => {
  it('matches how-to / step-by-step phrasings', () => {
    const procedural = [
      'How do I install and build raylib, including dependencies and build systems?',
      'How do I set up a new default widget in a producer dashboard?',
      'What are the steps to configure the graphics backend?',
      'Walk me through the kb init flow',
      'In what order does the query orchestrator run its passes?',
      'What are the steps to publish the docs?',
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

  it('does not fire on a definitional-lead question that merely mentions workflow/setup', () => {
    // Opens with "What" and only carries weak cues (workflow / setting up) — should
    // stay explanatory, not be forced into numbered steps.
    expect(
      isProceduralQuestion(
        'What problem does kb solve, and what is the normal workflow for setting up indexing and querying?'
      )
    ).toBe(false)
  })

  it('still fires on a how-to question even when it opens with a wh-word phrase', () => {
    // Strong trigger ("how do I") overrides the definitional-lead guard.
    expect(isProceduralQuestion('How do I install and build raylib?')).toBe(true)
    expect(isProceduralQuestion('What are the steps to configure the backend?')).toBe(true)
  })

  it('matches sequence-framing questions (trace / in order / sequence of)', () => {
    const sequence = [
      'Trace raylib\'s standard render loop in order — what do BeginDrawing and EndDrawing each do?',
      'What happens inside InitWindow, in order?',
      'Describe the sequence of events when a base is bootstrapped.',
      'Explain the order in which the init cycles run.',
    ]
    for (const q of sequence) {
      expect(isProceduralQuestion(q), q).toBe(true)
    }
  })

  it('does not treat the purpose phrase "in order to" as sequence framing', () => {
    // "in order to" is purpose, not sequence; nothing else here is procedural.
    expect(isProceduralQuestion('What flags do you pass in order to enable vsync?')).toBe(false)
  })

  it('can be disabled with KB_PROCEDURAL_SYNTHESIS=false', () => {
    const prev = process.env.KB_PROCEDURAL_SYNTHESIS
    try {
      process.env.KB_PROCEDURAL_SYNTHESIS = 'false'
      expect(isProceduralQuestion('How do I install and build raylib?')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.KB_PROCEDURAL_SYNTHESIS
      else process.env.KB_PROCEDURAL_SYNTHESIS = prev
    }
  })

  it('exposes non-empty ordering guidance for wiring into synthesis prompts', () => {
    expect(PROCEDURAL_SYNTHESIS_GUIDANCE).toContain('ordered')
    expect(PROCEDURAL_SYNTHESIS_GUIDANCE.length).toBeGreaterThan(200)
  })
})
