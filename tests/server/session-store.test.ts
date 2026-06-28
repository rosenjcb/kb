import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import { SessionStore } from '../../src/server/session-store'

const user = (content: string): Message => ({ role: 'user', content })
const assistant = (content: string): Message => ({ role: 'assistant', content })

describe('SessionStore', () => {
                it('[TC-54] returns empty history for an unknown session', () => {
    expect(new SessionStore().get('nope')).toEqual([])
  })

                it('[TC-55] appends user/assistant turns and reads them back', () => {
    const store = new SessionStore()
    store.append('s1', user('hi'), assistant('hello'))
    store.append('s1', user('more?'), assistant('sure'))
    const history = store.get('s1')
    expect(history.map(m => m.content)).toEqual(['hi', 'hello', 'more?', 'sure'])
  })

                it('[TC-56] trims to the configured turn cap', () => {
    const store = new SessionStore({ maxTurns: 1 })
    store.append('s1', user('first'), assistant('a1'))
    store.append('s1', user('second'), assistant('a2'))
    const history = store.get('s1')
    expect(history).toHaveLength(2)
    expect(history.map(m => m.content)).toEqual(['second', 'a2'])
  })

                it('[TC-57] evicts sessions past their TTL', () => {
    const store = new SessionStore({ ttlMs: -1 })
    store.append('s1', user('hi'), assistant('hello'))
    expect(store.get('s1')).toEqual([])
    expect(store.size()).toBe(0)
  })

                it('[TC-58] clear removes a single session', () => {
    const store = new SessionStore()
    store.append('s1', user('hi'), assistant('hello'))
    store.clear('s1')
    expect(store.get('s1')).toEqual([])
  })
})
