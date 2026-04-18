import { describe, expect, it } from 'vitest'
import {
  answerNeedsSearch,
  classifyChatTurn,
  createInitialConversationState,
  resolveConversationalChatTurn,
  updateConversationState,
} from '../../src/cli/chat-conversation'

describe('chat-conversation', () => {
  it('Given a confirmation after a pending search, then it resolves to the prior retrieval query', () => {
    const state = {
      ...createInitialConversationState(),
      activeTopic: 'tui implementation',
      lastRetrievalQuery: 'tui implementation',
      pendingFollowUp: {
        kind: 'search' as const,
        query: 'tui implementation',
        reason: 'assistant-requested-search',
      },
    }

    const resolved = resolveConversationalChatTurn('Yeah let’s do the search', state)

    expect(resolved.type).toBe('confirmation')
    expect(resolved.retrievalQuery).toBe('tui implementation')
    expect(resolved.answerFocus).toBe('tui implementation')
  })

  it('Given a clarification turn, then it extends the active topic instead of treating it as a brand-new query', () => {
    const state = {
      ...createInitialConversationState(),
      activeTopic: 'graph aware hybrid ranking',
    }

    const resolved = resolveConversationalChatTurn('Which files implement it?', state)

    expect(classifyChatTurn('Which files implement it?', state)).toBe('clarification')
    expect(resolved.retrievalQuery).toContain('graph aware hybrid ranking')
    expect(resolved.retrievalQuery).toContain('files')
  })

  it('Given a standalone explicit follow-up topic, then it retrieves on that topic instead of dragging the whole prior topic along', () => {
    const state = {
      ...createInitialConversationState(),
      activeTopic: 'agent loop',
    }

    const resolved = resolveConversationalChatTurn('What about TUI?', state)

    expect(resolved.type).toBe('follow-up')
    expect(resolved.retrievalQuery).toBe('TUI')
    expect(resolved.topic).toBe('TUI')
  })

  it('Given an answer that asks the user to search, then state keeps a pending follow-up for the next turn', () => {
    const state = createInitialConversationState()
    const resolved = resolveConversationalChatTurn('What is TUI and how do we implement it?', state)

    const next = updateConversationState(
      state,
      resolved,
      {
        answer: 'The retrieved documents do not provide information yet. Please let me know if you would like me to perform this search.',
        retrievedDocIds: ['kb-system-overview'],
      },
      4,
    )

    expect(answerNeedsSearch(next.recentTurns[0]?.assistant ?? '')).toBe(true)
    expect(next.pendingFollowUp?.query).toBe(resolved.retrievalQuery)
    expect(next.needsSearch).toBe(true)
    expect(next.lastRetrievedDocIds).toEqual(['kb-system-overview'])
  })
})
