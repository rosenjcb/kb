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
        answer:
          'The retrieved documents do not provide information yet. Please let me know if you would like me to perform this search.',
        retrievedDocIds: ['kb-system-overview'],
      },
      4
    )

    expect(answerNeedsSearch(next.recentTurns[0]?.assistant ?? '')).toBe(true)
    expect(next.pendingFollowUp?.query).toBe(resolved.retrievalQuery)
    expect(next.needsSearch).toBe(true)
    expect(next.lastRetrievedDocIds).toEqual(['kb-system-overview'])
  })

  it('Given initial state, then sessionFactPool is empty', () => {
    const state = createInitialConversationState()
    expect(state.sessionFactPool).toEqual([])
  })

  it('Given a turn with new facts, then updateConversationState accumulates them into the session pool', () => {
    const state = createInitialConversationState()
    const resolved = resolveConversationalChatTurn('What is the agent loop?', state)

    const next = updateConversationState(
      state,
      resolved,
      {
        answer: 'The agent loop orchestrates retrieval.',
        retrievedDocIds: ['fact-a', 'fact-b'],
        newFacts: [
          { id: 'fact-a', text: 'Agent loop orchestrates retrieval.' },
          { id: 'fact-b', text: 'Agent loop calls tools.' },
        ],
      },
      8
    )

    expect(next.sessionFactPool).toHaveLength(2)
    expect(next.sessionFactPool.map(f => f.id)).toEqual(['fact-a', 'fact-b'])
  })

  it('Given facts already in the pool, then updateConversationState deduplicates on id', () => {
    const state = {
      ...createInitialConversationState(),
      sessionFactPool: [{ id: 'fact-a', text: 'Agent loop orchestrates retrieval.' }],
    }
    const resolved = resolveConversationalChatTurn('Tell me more', state)

    const next = updateConversationState(
      state,
      resolved,
      {
        answer: 'More detail.',
        retrievedDocIds: ['fact-a', 'fact-c'],
        newFacts: [
          { id: 'fact-a', text: 'Agent loop orchestrates retrieval.' },
          { id: 'fact-c', text: 'Agent loop uses graph hops.' },
        ],
      },
      8
    )

    expect(next.sessionFactPool).toHaveLength(2)
    expect(next.sessionFactPool.map(f => f.id)).toContain('fact-a')
    expect(next.sessionFactPool.map(f => f.id)).toContain('fact-c')
  })

  it('Given a follow-up with 2+ new substantive terms, then it uses those terms as the retrieval query rather than prepending the active topic', () => {
    const state = {
      ...createInitialConversationState(),
      activeTopic: 'agent loop',
    }

    // "ast" and "python" are new terms not in "agent loop"
    const resolved = resolveConversationalChatTurn(
      'What about the ast? How can I add support for python?',
      state
    )

    expect(resolved.type).toBe('follow-up')
    expect(resolved.retrievalQuery).not.toContain('agent loop')
    expect(resolved.retrievalQuery).toContain('ast')
    expect(resolved.retrievalQuery).toContain('python')
  })

  it('Given a vague follow-up with only 1 new substantive term, then it appends to the active topic', () => {
    const state = {
      ...createInitialConversationState(),
      activeTopic: 'graph aware hybrid ranking',
    }

    // "this feature?" — "this" matches FOLLOW_UP_PATTERN, "feature" is the only new term
    const resolved = resolveConversationalChatTurn('this feature?', state)

    expect(resolved.type).toBe('follow-up')
    expect(resolved.retrievalQuery).toContain('graph aware hybrid ranking')
    expect(resolved.retrievalQuery).toContain('feature')
  })
})
