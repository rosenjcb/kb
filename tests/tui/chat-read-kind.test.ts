import { describe, expect, it } from 'vitest'
import {
  classifyChatReadPromptKind,
  shouldStartChatPending,
} from '@kb/client/tui/chat-read-kind.js'

describe('tui/chat-read-kind', () => {
  describe('classifyChatReadPromptKind', () => {
    it('[TC-15] classifies the idle you> prompt as chat', () => {
      expect(classifyChatReadPromptKind('you> ')).toBe('chat')
      expect(classifyChatReadPromptKind('you>')).toBe('chat')
      expect(classifyChatReadPromptKind('  you>  ')).toBe('chat')
    })

    it('[TC-16] classifies non-idle prompts as command prompts', () => {
      expect(classifyChatReadPromptKind('> Knowledge base name [kb] ')).toBe('command')
      expect(classifyChatReadPromptKind('[kb init] Choose a knowledge base name for this run.')).toBe(
        'command'
      )
      expect(classifyChatReadPromptKind('Enter number (1-4): ')).toBe('command')
    })

    it('[TC-17] uses the first non-empty line for multiline prompts', () => {
      const prompt = '\n\n[kb init] Choose a knowledge base name for this run.\n\n> Name [kb] '
      expect(classifyChatReadPromptKind(prompt)).toBe('command')
    })
  })

  describe('shouldStartChatPending', () => {
    it('[TC-18] starts pending only for non-slash chat turns', () => {
      expect(shouldStartChatPending({ isSlash: false, readKind: 'chat' })).toBe(true)
    })

    it('[TC-19] does not start pending for slash commands', () => {
      expect(shouldStartChatPending({ isSlash: true, readKind: 'chat' })).toBe(false)
    })

    it('[TC-20] does not start pending for command/interview prompt answers', () => {
      expect(shouldStartChatPending({ isSlash: false, readKind: 'command' })).toBe(false)
      expect(shouldStartChatPending({ isSlash: true, readKind: 'command' })).toBe(false)
    })
  })
})
