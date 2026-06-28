import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptSessionDraft,
  allAnswerSlotsResolved,
  applyAnswer,
  applySkip,
  createSessionRecord,
  firstPendingAnswerIndex,
  loadSession,
  saveSession,
  setSessionDraft,
  type UserDefinedDocSection,
} from '../../src/core/doc-generate-session'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('doc-generate-session', () => {
  it('[TC-22] Given new session, then first pending index is 0 and not all resolved', async () => {
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

  it('[TC-23] Given answers applied until last, then status becomes ready', async () => {
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

  it('[TC-24] Given skip on pending slot, then advances and can reach ready', async () => {
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

  it('[TC-25] Given setSessionDraft twice, then revisions log holds unified diff', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-session-'))
    tempDirs.push(dir)
    const session = createSessionRecord({
      prompt: 'p',
      docType: 'howto',
      questions: [{ key: 'a', question: 'Q?' }],
    })
    await saveSession(dir, session)
    await applyAnswer(dir, session.id, 'x')
    const now = Date.now()
    await setSessionDraft(dir, session.id, {
      revision: 1,
      content: 'alpha\n',
      contentWithFooter: 'alpha\n\n## References\n',
      supportingFactIds: ['f1'],
      createdAt: now,
    })
    let s = await loadSession(dir, session.id)
    expect(s?.status).toBe('awaiting_review')
    expect(s?.revisions).toEqual([])
    await setSessionDraft(dir, session.id, {
      revision: 2,
      content: 'beta\n',
      contentWithFooter: 'beta\n\n## References\n',
      supportingFactIds: ['f1'],
      feedback: 'change it',
      createdAt: now + 1,
    })
    s = await loadSession(dir, session.id)
    expect(s?.revisions?.length).toBe(1)
    expect(s?.revisions?.[0]?.fromRevision).toBe(1)
    expect(s?.revisions?.[0]?.revision).toBe(2)
    expect(s?.revisions?.[0]?.diff).toContain('-alpha')
    expect(s?.revisions?.[0]?.diff).toContain('+beta')
  })

  it('[TC-26] Given sections provided, then status is ready immediately with no gathering phase', () => {
    const sections: UserDefinedDocSection[] = [
      { name: 'Overview', description: 'High-level summary' },
      { name: 'Usage', description: 'How to use it' },
    ]
    const session = createSessionRecord({
      prompt: 'Explain the CLI',
      docType: 'howto',
      questions: [],
      sections,
    })
    expect(session.status).toBe('ready')
    expect(session.sections).toEqual(sections)
    expect(session.answers).toEqual([])
    expect(firstPendingAnswerIndex(session)).toBeNull()
    expect(allAnswerSlotsResolved(session)).toBe(true)
  })

  it('[TC-27] Given sections provided, then sections are persisted and reloaded correctly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-session-sections-'))
    tempDirs.push(dir)
    const sections: UserDefinedDocSection[] = [
      { name: 'Background', description: 'Context for the decision' },
      { name: 'Decision', description: 'What was decided' },
    ]
    const session = createSessionRecord({
      prompt: 'Architecture decision record',
      docType: 'decision',
      questions: [],
      sections,
    })
    await saveSession(dir, session)
    const loaded = await loadSession(dir, session.id)
    expect(loaded?.sections).toEqual(sections)
    expect(loaded?.status).toBe('ready')
  })

  it('[TC-28] Given no sections, then status starts as gathering with non-empty questions', () => {
    const session = createSessionRecord({
      prompt: 'normal flow',
      docType: 'howto',
      questions: [{ key: 'goal', question: 'Goal?' }],
    })
    expect(session.status).toBe('gathering')
    expect(session.sections).toBeUndefined()
  })

  it('[TC-29] Given acceptSessionDraft, then status finalized and draft preserved', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-session-'))
    tempDirs.push(dir)
    const session = createSessionRecord({
      prompt: 'p',
      docType: 'reference',
      questions: [{ key: 'a', question: 'Q?' }],
    })
    await saveSession(dir, session)
    await applyAnswer(dir, session.id, 'ans')
    await setSessionDraft(dir, session.id, {
      revision: 1,
      content: 'body',
      contentWithFooter: 'body\nfooter',
      supportingFactIds: ['id1'],
      createdAt: Date.now(),
    })
    await acceptSessionDraft(dir, session.id, { draftDocId: 'doc-99' })
    const s = await loadSession(dir, session.id)
    expect(s?.status).toBe('finalized')
    expect(s?.draftDocId).toBe('doc-99')
    expect(s?.supportingFactIds).toEqual(['id1'])
    expect(s?.draft?.revision).toBe(1)
  })
})
