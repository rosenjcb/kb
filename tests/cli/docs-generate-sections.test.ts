import { describe, expect, it } from 'vitest'
import { promptUserDocSections } from '../../src/cli/docs-generate-sections'

function makeIO(responses: Array<string | null>) {
  const lines: string[] = []
  let idx = 0
  return {
    io: {
      writeLine: (msg: string) => lines.push(msg),
      readLine: async (_prompt: string) => responses[idx++] ?? null,
    },
    lines,
  }
}

describe('promptUserDocSections', () => {
  it('Given /skip, then returns skip without asking for descriptions', async () => {
    const { io } = makeIO(['/skip'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('skip')
  })

  it('Given blank input, then returns skip', async () => {
    const { io } = makeIO([''])
    const result = await promptUserDocSections(io)
    expect(result).toBe('skip')
  })

  it('Given /cancel on name prompt, then returns cancel', async () => {
    const { io } = makeIO(['/cancel'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given null read on name prompt, then returns cancel', async () => {
    const { io } = makeIO([null])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given name then /cancel on description, then returns cancel', async () => {
    const { io } = makeIO(['Overview', '/cancel'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given multiple sections one at a time, then returns sections after /complete', async () => {
    const { io } = makeIO(['Overview', '', 'Usage', 'How to use it', '/complete', '/accept'])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([
      { name: 'Overview', description: 'Content about overview' },
      { name: 'Usage', description: 'How to use it' },
    ])
  })

  it('Given sections with descriptions, then returns sections with user descriptions', async () => {
    const { io } = makeIO([
      'Background',
      'Why this matters',
      'Steps',
      'What to do',
      'Verification',
      'How to confirm it worked',
      '/complete',
      '/accept',
    ])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([
      { name: 'Background', description: 'Why this matters' },
      { name: 'Steps', description: 'What to do' },
      { name: 'Verification', description: 'How to confirm it worked' },
    ])
  })

  it('Given blank description for a section, then uses default', async () => {
    const { io } = makeIO(['API Reference', '', '/complete', '/accept'])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([{ name: 'API Reference', description: 'Content about api reference' }])
  })

  it('Given /complete with no sections, then returns skip', async () => {
    const { io } = makeIO(['/complete'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('skip')
  })

  it('Given each added section, then writes running list to output', async () => {
    const { io, lines } = makeIO(['Alpha', 'desc a', 'Beta', 'desc b', '/complete', '/accept'])
    await promptUserDocSections(io)
    const listOutput = lines.join('\n')
    expect(listOutput).toContain('Sections so far')
    expect(listOutput).toContain('1. Alpha')
    expect(listOutput).toContain('2. Beta')
  })
})
