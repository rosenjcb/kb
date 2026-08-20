import { describe, expect, it } from 'vitest'
import {
  CHAT_IO_CATEGORY,
  classifyChatIOLine,
} from '@kb/client/tui/chat-io-classify.js'

describe('tui/chat-io-classify', () => {
  describe('CHAT_IO_CATEGORY constants', () => {
    it('[TC-G85D] has the three expected tier values', () => {
      expect(CHAT_IO_CATEGORY.META).toBe('meta')
      expect(CHAT_IO_CATEGORY.ASSISTANT).toBe('assistant')
      expect(CHAT_IO_CATEGORY.SKIP).toBe('skip')
    })
  })

  describe('classifyChatIOLine — T1 metadata', () => {
    it('[TC-B5OA] classifies orchestration wire lines as META', () => {
      expect(classifyChatIOLine('retrieval> hybrid').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('evidence> some fact').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('sources> fact://abc').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('matches> 5').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('thinking> planning').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('sep> —').category).toBe(CHAT_IO_CATEGORY.META)
    })

    it('[TC-KS6O] classifies init/scan progress lines as META', () => {
      expect(classifyChatIOLine('[init] phase: read-inputs').category).toBe(CHAT_IO_CATEGORY.META)
      expect(classifyChatIOLine('[scan] processing file').category).toBe(CHAT_IO_CATEGORY.META)
    })

    it('[TC-RG7T] preserves full wire line as content for META', () => {
      const result = classifyChatIOLine('retrieval> hybrid;iterations:2')
      expect(result.category).toBe(CHAT_IO_CATEGORY.META)
      expect(result.content).toBe('retrieval> hybrid;iterations:2')
    })

    it('[TC-J4XM] classifies a source> line carrying an OSC-8 hyperlink as META — the escape bytes sit after the prefix, not inside it', () => {
      const osc8 = '\x1b]8;;https://github.com/rosenjcb/kb/blob/main/src/a.ts\x07src/a.ts\x1b]8;;\x07'
      const result = classifyChatIOLine(`source> ${osc8} · foo`)
      expect(result.category).toBe(CHAT_IO_CATEGORY.META)
    })
  })

  describe('classifyChatIOLine — T3 assistant content', () => {
    it('[TC-APKJ] strips assistant> prefix and classifies as ASSISTANT', () => {
      const result = classifyChatIOLine('assistant> Here is the answer')
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Here is the answer')
    })

    it('[TC-WLF2] does NOT classify assistant> as META', () => {
      expect(classifyChatIOLine('assistant> hello').category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
    })

    it('[TC-999B] classifies plain text as ASSISTANT', () => {
      const result = classifyChatIOLine('Some plain answer text')
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Some plain answer text')
    })

    it('[TC-ZZZY] handles multiline assistant content (full body as single write)', () => {
      const multiline = 'assistant> Line one\nLine two\nLine three'
      const result = classifyChatIOLine(multiline)
      expect(result.category).toBe(CHAT_IO_CATEGORY.ASSISTANT)
      expect(result.content).toBe('Line one\nLine two\nLine three')
    })
  })

  describe('classifyChatIOLine — SKIP', () => {
    it('[TC-6P72] classifies blank lines as SKIP', () => {
      expect(classifyChatIOLine('').category).toBe(CHAT_IO_CATEGORY.SKIP)
      expect(classifyChatIOLine('   ').category).toBe(CHAT_IO_CATEGORY.SKIP)
    })

    it('[TC-M2H9] returns empty content for SKIP', () => {
      expect(classifyChatIOLine('').content).toBe('')
    })

    it('[TC-34P4] classifies assistant> with blank body as SKIP', () => {
      expect(classifyChatIOLine('assistant> ').category).toBe(CHAT_IO_CATEGORY.SKIP)
      // 'assistant>' (no trailing space) falls through to ASSISTANT — not a SKIP
    })
  })
})
