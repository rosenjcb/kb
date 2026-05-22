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

  it('Given /accept then /cancel on description, then returns cancel', async () => {
    const { io } = makeIO(['Overview, Usage', '/accept', '/cancel'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given valid names then /reject then retry and /accept, then loops and returns sections', async () => {
    const { io } = makeIO([
      'Overview, Usage',  // first attempt
      '/reject',          // reject → loops back
      'Overview, Usage',  // second attempt
      '/accept',          // accept
      '',                 // blank description for Overview → uses default
      'How to use it',    // description for Usage
    ])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([
      { name: 'Overview', description: 'Content about overview' },
      { name: 'Usage', description: 'How to use it' },
    ])
  })

  it('Given comma-separated names with /accept and descriptions, then returns sections with user descriptions', async () => {
    const { io } = makeIO([
      'Background, Steps, Verification',
      '/accept',
      'Why this matters',
      'What to do',
      'How to confirm it worked',
    ])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([
      { name: 'Background', description: 'Why this matters' },
      { name: 'Steps', description: 'What to do' },
      { name: 'Verification', description: 'How to confirm it worked' },
    ])
  })

  it('Given blank description for a section, then uses default', async () => {
    const { io } = makeIO(['API Reference', '/accept', ''])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([{ name: 'API Reference', description: 'Content about api reference' }])
  })

  it('Given names with extra whitespace and empty tokens, then trims and filters', async () => {
    const { io } = makeIO([' Intro ,  , Summary ', '/accept', 'The intro', 'The summary'])
    const result = await promptUserDocSections(io)
    expect(result).toEqual([
      { name: 'Intro', description: 'The intro' },
      { name: 'Summary', description: 'The summary' },
    ])
  })

  it('Given /cancel on confirmation prompt, then returns cancel', async () => {
    const { io } = makeIO(['Overview', '/cancel'])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given null read on confirmation prompt, then returns cancel', async () => {
    const { io } = makeIO(['Overview', null])
    const result = await promptUserDocSections(io)
    expect(result).toBe('cancel')
  })

  it('Given /accept, then writes numbered section list to output before asking descriptions', async () => {
    const { io, lines } = makeIO(['Alpha, Beta', '/accept', 'desc a', 'desc b'])
    await promptUserDocSections(io)
    const listOutput = lines.join('\n')
    expect(listOutput).toContain('1. Alpha')
    expect(listOutput).toContain('2. Beta')
  })
})
