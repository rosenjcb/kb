import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseShellArgs, runCommandForTui } from '../../src/tui/runner.js'

// ---------------------------------------------------------------------------
// parseShellArgs
// ---------------------------------------------------------------------------

describe('parseShellArgs', () => {
  it('splits a plain command into tokens', () => {
    expect(parseShellArgs('query docs graph')).toEqual(['query', 'docs', 'graph'])
  })

  it('handles a double-quoted argument', () => {
    expect(parseShellArgs('query "what is the project"')).toEqual(['query', 'what is the project'])
  })

  it('handles a single-quoted argument', () => {
    expect(parseShellArgs("query 'what is the project'")).toEqual(['query', 'what is the project'])
  })

  it('handles multiple quoted args', () => {
    expect(parseShellArgs('submit "fact one" --base "my base"')).toEqual([
      'submit',
      'fact one',
      '--base',
      'my base',
    ])
  })

  it('ignores leading and trailing whitespace', () => {
    expect(parseShellArgs('  query  docs  ')).toEqual(['query', 'docs'])
  })

  it('returns empty array for blank input', () => {
    expect(parseShellArgs('')).toEqual([])
    expect(parseShellArgs('   ')).toEqual([])
  })

  it('handles an unclosed quote by appending the partial token', () => {
    // Unclosed quote → rest of string is the token
    expect(parseShellArgs('query "unclosed')).toEqual(['query', 'unclosed'])
  })
})

// ---------------------------------------------------------------------------
// runCommandForTui — output capture
// ---------------------------------------------------------------------------

vi.mock('../../src/cli/index.js', () => ({
  runMainWithOutput: vi.fn(),
  printCliHelp: vi.fn(() => 'kb help text'),
}))

import { runMainWithOutput } from '../../src/cli/index.js'

describe('runCommandForTui', () => {
  beforeEach(() => {
    vi.mocked(runMainWithOutput).mockReset()
  })

  it('captures log output from runMainWithOutput', async () => {
    vi.mocked(runMainWithOutput).mockImplementation(async (_args, out) => {
      out.log('line one')
      out.log('line two')
    })

    const result = await runCommandForTui(['docs', 'list'], {} as never)
    expect(result).toBe('line one\nline two')
  })

  it('captures error output from runMainWithOutput', async () => {
    vi.mocked(runMainWithOutput).mockImplementation(async (_args, out) => {
      out.error('something went wrong')
    })

    const result = await runCommandForTui(['docs', 'list'], {} as never)
    expect(result).toBe('something went wrong')
  })

  it('captures write (streaming) output', async () => {
    vi.mocked(runMainWithOutput).mockImplementation(async (_args, out) => {
      out.write('chunk one\n')
      out.write('chunk two\n')
    })

    const result = await runCommandForTui(['docs', 'view', 'some-doc'], {} as never)
    expect(result).toBe('chunk one\nchunk two')
  })

  it('returns empty string when runMainWithOutput produces no output', async () => {
    vi.mocked(runMainWithOutput).mockResolvedValue(undefined)
    const result = await runCommandForTui(['config', 'get'], {} as never)
    expect(result).toBe('')
  })

  it('captures thrown errors as output text', async () => {
    vi.mocked(runMainWithOutput).mockRejectedValue(new Error('provider not configured'))
    const result = await runCommandForTui(['query', 'test'], {} as never)
    expect(result).toBe('provider not configured')
  })

  it('passes args through to runMainWithOutput', async () => {
    vi.mocked(runMainWithOutput).mockResolvedValue(undefined)
    await runCommandForTui(['docs', 'list', '--limit', '5'], {} as never)
    expect(runMainWithOutput).toHaveBeenCalledWith(
      ['docs', 'list', '--limit', '5'],
      expect.any(Object),
      expect.any(Object),
      'tui',
      undefined
    )
  })
})
