import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allAnswerSlotsResolved,
  applyAnswer,
  applySkip,
  createSessionRecord,
  firstPendingAnswerIndex,
  loadSession,
  saveSession,
} from '../../src/core/doc-generate-session'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('doc-generate-session', () => {
  it('Given new session, then first pending index is 0 and not all resolved', async () => {
    const session = createSessionRecord({
      prompt: 'Explain auth',
      docType: 'reference',
      questions: [
        { key: 'a', question: 'Q1?' },
        { key: 'b', question: 'Q2?' },
      ],
    })
    expect(firstPendingAnswerIndex(session)).toBe(0)
    expect(allAnswerSlotsResolved(session)).toBe(false)
  })

  it('Given answers applied until last, then status becomes ready', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-session-'))
    tempDirs.push(dir)
    const session = createSessionRecord({
      prompt: 'p',
      docType: 'howto',
      questions: [
        { key: 'goal', question: 'Goal?' },
        { key: 'prereqs', question: 'Pre?' },
      ],
    })
    await saveSession(dir, session)

    await applyAnswer(dir, session.id, 'achieve X')
    let s = await loadSession(dir, session.id)
    expect(s).not.toBeNull()
    if (s === null) throw new Error('expected session')
    expect(s.status).toBe('gathering')
    expect(firstPendingAnswerIndex(s)).toBe(1)

    await applyAnswer(dir, session.id, 'none')
    s = await loadSession(dir, session.id)
    expect(s).not.toBeNull()
    if (s === null) throw new Error('expected session')
    expect(s.status).toBe('ready')
    expect(firstPendingAnswerIndex(s)).toBeNull()
    expect(allAnswerSlotsResolved(s)).toBe(true)
  })

  it('Given skip on pending slot, then advances and can reach ready', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-session-'))
    tempDirs.push(dir)
    const session = createSessionRecord({
      prompt: 'p',
      docType: 'decision',
      questions: [
        { key: 'context', question: 'C?' },
        { key: 'choice', question: 'Ch?' },
      ],
    })
    await saveSession(dir, session)
    await applySkip(dir, session.id)
    await applyAnswer(dir, session.id, 'pick A')
    const s = await loadSession(dir, session.id)
    expect(s?.status).toBe('ready')
    expect(s?.answers[0].skipped).toBe(true)
    expect(s?.answers[1].answer).toBe('pick A')
  })
})
