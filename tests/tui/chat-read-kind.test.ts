import { describe, expect, it } from 'vitest'
import {
  classifyChatReadPromptKind,
  shouldStartChatPending,
} from '../../src/tui/chat-read-kind'

describe('tui/chat-read-kind', () => {
  describe('classifyChatReadPromptKind', () => {
    it('classifies the idle you> prompt as chat', () => {
      expect(classifyChatReadPromptKind('you> ')).toBe('chat')
      expect(classifyChatReadPromptKind('you>')).toBe('chat')
      expect(classifyChatReadPromptKind('  you>  ')).toBe('chat')
    })

    it('classifies non-idle prompts as command prompts', () => {
      expect(classifyChatReadPromptKind('> Knowledge base name [kb] ')).toBe('command')
      expect(classifyChatReadPromptKind('[kb init] Choose a knowledge base name for this run.')).toBe(
        'command'
      )
      expect(classifyChatReadPromptKind('Enter number (1-4): ')).toBe('command')
    })

    it('uses the first non-empty line for multiline prompts', () => {
      const prompt = '\n\n[kb init] Choose a knowledge base name for this run.\n\n> Name [kb] '
      expect(classifyChatReadPromptKind(prompt)).toBe('command')
    })
  })

  describe('shouldStartChatPending', () => {
    it('starts pending only for non-slash chat turns', () => {
      expect(shouldStartChatPending({ isSlash: false, readKind: 'chat' })).toBe(true)
    })

    it('does not start pending for slash commands', () => {
      expect(shouldStartChatPending({ isSlash: true, readKind: 'chat' })).toBe(false)
    })

    it('does not start pending for command/interview prompt answers', () => {
      expect(shouldStartChatPending({ isSlash: false, readKind: 'command' })).toBe(false)
      expect(shouldStartChatPending({ isSlash: true, readKind: 'command' })).toBe(false)
    })
  })
})
