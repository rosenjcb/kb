import { describe, expect, it } from 'vitest'
import {
  MAX_SYMBOL_MENTIONS,
  extractSymbolMentions,
} from '@kb/core/query/symbol-mentions.js'

const names = (q: string) => extractSymbolMentions(q).map(m => m.name)

describe('extractSymbolMentions', () => {
  it('[TC-SYM1] Given a CamelCase identifier in prose, then it is a strict mention', () => {
    const ms = extractSymbolMentions('what does the ExecutionController own?')
    expect(ms.find(m => m.name === 'ExecutionController')?.confidence).toBe('strict')
  })

  it('[TC-SYM2] Given a snake_case identifier, then it is a strict mention', () => {
    const ms = extractSymbolMentions('how are rows written to code_symbols during indexing?')
    expect(ms.find(m => m.name === 'code_symbols')?.confidence).toBe('strict')
  })

  it('[TC-SYM3] Given a backticked span with a path and a symbol, then each identifier is taken and the extension is dropped', () => {
    const got = names('see `FlowCreate.vue handleImportSubmit` for the import path')
    expect(got).toContain('FlowCreate')
    expect(got).toContain('handleImportSubmit')
  })

  it('[TC-SYM4] Given a bare lowercase word naming a declaration, then it is a loose mention', () => {
    // The kestra Q6 case: prose says "the scheduler", the declaration is `Scheduler`.
    const ms = extractSymbolMentions(
      'infer the path from editing a trigger in the UI to the scheduler actually firing a new execution'
    )
    expect(ms.find(m => m.name === 'scheduler')?.confidence).toBe('loose')
  })

  it('[TC-SYM5] Given generic vocabulary, then it is not offered as a mention', () => {
    // These name hundreds of declarations apiece; promoting them is pure noise.
    const got = names('how does the service handle a request from the client to the server?')
    for (const noise of ['service', 'request', 'client', 'server', 'handle']) {
      expect(got).not.toContain(noise)
    }
  })

  it('[TC-SYM6] Given a short lowercase word, then it is below the loose-mention floor', () => {
    expect(names('what does the node do?')).not.toContain('node')
  })

  it('[TC-SYM7] Given many candidates, then the list is capped and strict mentions survive the cut', () => {
    const q = `${'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike '}TreeSitterIndexer`
    const ms = extractSymbolMentions(q)
    expect(ms.length).toBeLessThanOrEqual(MAX_SYMBOL_MENTIONS)
    expect(ms.map(m => m.name)).toContain('TreeSitterIndexer')
  })

  it('[TC-SYM8] Given an empty or whitespace query, then no mentions are returned', () => {
    expect(extractSymbolMentions('')).toEqual([])
    expect(extractSymbolMentions('   ')).toEqual([])
  })

  it('[TC-SYM9] Given the same identifier twice, then it is offered once', () => {
    const got = names('does retrieveHybrid call retrieveHybrid recursively?')
    expect(got.filter(n => n === 'retrieveHybrid')).toHaveLength(1)
  })
})
