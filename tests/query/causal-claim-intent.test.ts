import { afterEach, describe, expect, it } from 'vitest'
import {
  NEGATIVE_CLAIM_SYNTHESIS_GUIDANCE,
  causalTargetProbe,
  detectCausalTarget,
  isNegativeClaimGuardEnabled,
} from '@kb/core/query/causal-claim-intent.js'

afterEach(() => {
  process.env.KB_QUERY_NEGATIVE_CLAIM_GUARD = undefined
})

describe('detectCausalTarget', () => {
  it('[TC-NCG1] Given a "could X leave Y ..." question, then it extracts Y as the target', () => {
    const t = detectCausalTarget(
      'could the YAML import path leave the flow store in a state where the Save button is disabled?'
    )
    expect(t).not.toBeNull()
    expect(t?.target).toContain('flow store')
  })

  it('[TC-NCG2] Given "does X affect Y", then it extracts Y rather than X', () => {
    const t = detectCausalTarget('does changing the retriever affect the citation output?')
    expect(t?.target).toContain('citation output')
    expect(t?.target).not.toContain('retriever')
  })

  it('[TC-NCG3] Given "is Y affected by X", then it extracts Y from the leading position', () => {
    const t = detectCausalTarget('is the embedding cache affected by a schema bump?')
    expect(t?.target).toContain('embedding cache')
  })

  it('[TC-NCG4] Given "without breaking Y", then it extracts Y', () => {
    const t = detectCausalTarget('can I rename the column without breaking the migration runner?')
    expect(t?.target).toContain('migration runner')
  })

  it('[TC-NCG5] Given a plain lookup question, then it returns null so no probe is wasted', () => {
    expect(detectCausalTarget('where is the retriever implemented?')).toBeNull()
    expect(detectCausalTarget('what is a fact?')).toBeNull()
    expect(detectCausalTarget('')).toBeNull()
  })

  it('[TC-NCG6] Given a trailing subordinate clause, then the target stops before it', () => {
    const t = detectCausalTarget('does the scan break the index when the repo is empty?')
    expect(t?.target).not.toContain('when')
    expect(t?.target).not.toContain('empty')
  })

  it('[TC-NCG7] Given a long trailing phrase, then the target is capped to stay a usable probe', () => {
    const t = detectCausalTarget(
      'does this change break the extremely long and rambling subsystem name that keeps going well past any reasonable length'
    )
    expect(t).not.toBeNull()
    expect(t?.target.split(/\s+/).length).toBeLessThanOrEqual(8)
  })

  it('[TC-NCG8] Given a leading article on the target, then it is stripped', () => {
    const t = detectCausalTarget('does the reindex clear the session cache?')
    expect(t?.target.startsWith('the ')).toBe(false)
  })
})

describe('causalTargetProbe', () => {
  it('[TC-NCG9] Given a target, then the probe asks for its own definition rather than restating the question', () => {
    const probe = causalTargetProbe({ target: 'flow store' })
    expect(probe).toContain('flow store')
    expect(probe).toContain('definition')
    expect(probe).not.toContain('?')
  })
})

describe('isNegativeClaimGuardEnabled', () => {
  it('[TC-NCGA] Given no env var, then the guard is on', () => {
    process.env.KB_QUERY_NEGATIVE_CLAIM_GUARD = undefined
    expect(isNegativeClaimGuardEnabled()).toBe(true)
  })

  it('[TC-NCGB] Given the var set to "false", then the guard is off', () => {
    process.env.KB_QUERY_NEGATIVE_CLAIM_GUARD = 'false'
    expect(isNegativeClaimGuardEnabled()).toBe(false)
  })

  it('[TC-NCGC] Given an unrecognized value, then the guard stays on rather than silently disabling', () => {
    process.env.KB_QUERY_NEGATIVE_CLAIM_GUARD = 'nope'
    expect(isNegativeClaimGuardEnabled()).toBe(true)
  })
})

describe('NEGATIVE_CLAIM_SYNTHESIS_GUIDANCE', () => {
  it('[TC-NCGD] states that absence of evidence is not evidence of absence', () => {
    expect(NEGATIVE_CLAIM_SYNTHESIS_GUIDANCE).toMatch(/cannot, by absence/i)
    expect(NEGATIVE_CLAIM_SYNTHESIS_GUIDANCE).toMatch(/name what was not inspected/i)
  })
})
