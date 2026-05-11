import { describe, expect, it } from 'vitest'
import { classifyChatIOLine } from '../../src/tui/chat-io-classify'

describe('classifyChatIOLine', () => {
  // ── orchestration wire lines ────────────────────────────────────

  it('classifies stage> lines as meta', () => {
    expect(classifyChatIOLine('stage> answer:start').category).toBe('meta')
    expect(classifyChatIOLine('stage> retrieval:done 130ms').category).toBe('meta')
  })

  it('classifies retrieval> lines as meta', () => {
    expect(classifyChatIOLine('retrieval> hybrid (facts-loop;iterations:5)').category).toBe('meta')
  })

  it('classifies matches> and sources> lines as meta', () => {
    expect(classifyChatIOLine('matches> 12').category).toBe('meta')
    expect(classifyChatIOLine('sources> fact://abc123').category).toBe('meta')
  })

  it('classifies query> tool-call lines as meta', () => {
    expect(classifyChatIOLine('query> ToolRegistry register').category).toBe('meta')
  })

  it('classifies timing> lines as meta', () => {
    expect(classifyChatIOLine('timing> retrieval=90ms answer=1323ms total=1446ms').category).toBe('meta')
  })

  // ── init / scan progress lines ──────────────────────────────────

  it('classifies [init] progress bar lines as meta', () => {
    expect(classifyChatIOLine('[init] [===---------------------] 1/7 read-inputs').category).toBe('meta')
  })

  it('classifies [init:action] per-file lines as meta', () => {
    expect(
      classifyChatIOLine(
        '[init:action] code-facts files 0/10 (10 left) | processed 0, skipped 0, failed 0 | facts: +0 inserted, 0 superseded'
      ).category
    ).toBe('meta')
  })

  it('classifies [scan] and [scan:action] lines as meta', () => {
    expect(classifyChatIOLine('[scan] [===-----] 1/3 read-inputs').category).toBe('meta')
    expect(classifyChatIOLine('[scan:action] code-facts files 1/5').category).toBe('meta')
  })

  // ── assistant content ───────────────────────────────────────────

  it('classifies assistant> lines as assistant and strips the prefix', () => {
    const result = classifyChatIOLine('assistant> The KB uses hybrid retrieval.')
    expect(result.category).toBe('assistant')
    expect(result.content).toBe('The KB uses hybrid retrieval.')
  })

  it('classifies plain KB answer text as assistant', () => {
    const result = classifyChatIOLine('✅ Init complete — 8 docs written to "kb"')
    expect(result.category).toBe('assistant')
    expect(result.content).toBe('✅ Init complete — 8 docs written to "kb"')
  })

  it('classifies general assistant prose as assistant', () => {
    const result = classifyChatIOLine('To add a tool, call registry.register().')
    expect(result.category).toBe('assistant')
    expect(result.content).toBe('To add a tool, call registry.register().')
  })

  // ── blank / skip ────────────────────────────────────────────────

  it('classifies empty string as skip', () => {
    expect(classifyChatIOLine('').category).toBe('skip')
  })

  it('classifies whitespace-only lines as skip', () => {
    expect(classifyChatIOLine('   ').category).toBe('skip')
    expect(classifyChatIOLine('\n').category).toBe('skip')
  })

  // ── assistant> is NOT treated as meta ──────────────────────────

  it('does not classify assistant> lines as meta', () => {
    expect(classifyChatIOLine('assistant> hello').category).not.toBe('meta')
  })
})
