import { describe, expect, it } from 'vitest'
import { promptNamedListInterview } from '@kb/core/cli/named-list-interview.js'

function makeIO(responses: Array<string | null>) {
  const lines: string[] = []
  let idx = 0
  return {
    io: {
      write: (msg: string) => lines.push(msg),
      ask: async (_prompt: string) => {
        const answer = responses[idx++]
        if (answer === null) return '/cancel'
        return answer ?? ''
      },
    },
    lines,
  }
}

const defaultOptions = {
  label: 'test flow',
  itemNounSingular: 'item',
  itemNounPlural: 'items',
  listLabel: 'Items',
  defaultDescription: (name: string) => `About ${name.toLowerCase()}`,
}

describe('promptNamedListInterview', () => {
  it('[TC-356] Given /skip, then returns skip without asking for descriptions', async () => {
    const { io } = makeIO(['/skip'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'skip' })
  })

  it('[TC-357] Given blank input, then returns skip', async () => {
    const { io } = makeIO([''])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'skip' })
  })

  it('[TC-358] Given /cancel on name prompt, then returns cancel', async () => {
    const { io } = makeIO(['/cancel'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'cancel' })
  })

  it('[TC-359] Given null read on name prompt, then returns cancel', async () => {
    const { io } = makeIO([null])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'cancel' })
  })

  it('[TC-360] Given /complete with no items, then returns skip', async () => {
    const { io } = makeIO(['/complete'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'skip' })
  })

  it('[TC-361] Given name then /cancel on description, then returns cancel', async () => {
    const { io } = makeIO(['Overview', '/cancel'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'cancel' })
  })

  it('[TC-362] Given multiple names one at a time, then returns items after /complete and /accept', async () => {
    const { io } = makeIO(['Overview', '', 'Usage', 'How to use it', '/complete', '/accept'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({
      kind: 'accepted',
      items: [
        { name: 'Overview', description: 'About overview' },
        { name: 'Usage', description: 'How to use it' },
      ],
    })
  })

  it('[TC-363] Given blank description for an item, then uses default', async () => {
    const { io } = makeIO(['API Reference', '', '/complete', '/accept'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({
      kind: 'accepted',
      items: [{ name: 'API Reference', description: 'About api reference' }],
    })
  })

  it('[TC-364] Given each added item, then writes running list to output', async () => {
    const { io, lines } = makeIO(['Alpha', 'desc a', 'Beta', 'desc b', '/complete', '/accept'])
    await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    const listOutput = lines.join('\n')
    expect(listOutput).toContain('Items so far')
    expect(listOutput).toContain('1. Alpha')
    expect(listOutput).toContain('2. Beta')
  })

  it('[TC-365] Given /reject after /complete, then restarts collection from the beginning', async () => {
    const { io } = makeIO([
      'Overview',
      '',
      '/complete',
      '/reject',
      'Usage',
      'How to use it',
      '/complete',
      '/accept',
    ])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({
      kind: 'accepted',
      items: [{ name: 'Usage', description: 'How to use it' }],
    })
  })

  it('[TC-366] Given /cancel on final confirmation, then returns cancel', async () => {
    const { io } = makeIO(['Overview', '', '/complete', '/cancel'])
    const result = await promptNamedListInterview(io, defaultOptions, ({ name, description }) => ({
      name,
      description,
    }))
    expect(result).toEqual({ kind: 'cancel' })
  })
})
