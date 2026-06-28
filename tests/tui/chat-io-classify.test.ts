import { describe, expect, it } from 'vitest'
import {
  CHAT_IO_CATEGORY,
  classifyChatIOLine,
} from '../../src/tui/chat-io-classify'

describe('tui/chat-io-classify', () => {
  describe('CHAT_IO_CATEGORY constants', () => {
    it('[TC-4] has the three expected tier values', () => {
      expect(CHAT_IO_CATEGORY.META).toBe('meta')
      expect(CHAT_IO_CATEGORY.ASSISTANT).toBe('assistant')
      expect(CHAT_IO_CATEGORY.SKIP).toBe('skip')
    })
  })

  describe('classifyChatIOLine — T1 metadata', () => {
    it('[TC-5] classifies orchestration wire lines as META', () => {
      expect(classifyChatIOLine('retrieval> hybrid').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('evidence> some fact').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('sources> fact://abc').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('matches> 5').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('thinking> planning').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('sep> —').category).toBe(CHAT_IO_CATEGORY.META)
    })

    it('[TC-6] classifies init/scan progress lines as META', () => {
      expect(classifyChatIOLine('[init] phase: read-inputs').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('[scan] processing file').category).toBe(CHAT_IO_CATEGORY.META)
    })

    it('[TC-7] preserves full wire line as content for META', () => {
      const result = classifyChatIOLine('retrieval> hybrid;iterations:2')
      expect(result.category).toBe(CHAT_IO_CATEGORY.META)
      expect(result.content).toBe('retrieval> hybrid;iterations:2')
    })
  })

  describe('classifyChatIOLine — T3 assistant content', () => {
    it('[TC-8] strips assistant> prefix and classifies as ASSISTANT', () => {
      const result = classifyChatIOLine('assistant> Here is the answer')
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Here is the answer')
    })

    it('[TC-9] does NOT classify assistant> as META', () => {
      expect(classifyChatIOLine('assistant> hello').category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
    })

    it('[TC-10] classifies plain text as ASSISTANT', () => {
      const result = classifyChatIOLine('Some plain answer text')
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Some plain answer text')
    })

    it('[TC-11] handles multiline assistant content (full body as single write)', () => {
      const multiline = 'assistant> Line one\nLine two\nLine three'
      const result = classifyChatIOLine(multiline)
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Line one\nLine two\nLine three')
    })
  })

  describe('classifyChatIOLine — SKIP', () => {
    it('[TC-12] classifies blank lines as SKIP', () => {
      expect(classifyChatIOLine('').category).toBe(CHAT_IO_CATEGORY.SKIP)
      expect(classifyChatIOLine('   ').category).toBe(CHAT_IO_CATEGORY.SKIP)
    })

    it('[TC-13] returns empty content for SKIP', () => {
      expect(classifyChatIOLine('').content).toBe('')
    })

    it('[TC-14] classifies assistant> with blank body as SKIP', () => {
      expect(classifyChatIOLine('assistant> ').category).toBe(CHAT_IO_CATEGORY.SKIP)
      // 'assistant>' (no trailing space) falls through to ASSISTANT — not a SKIP
    })
  })
})
