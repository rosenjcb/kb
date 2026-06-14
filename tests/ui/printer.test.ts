import { describe, expect, it } from 'vitest'
import {
  condenseProgressText,
  createPrinter,
  createReasoningProgressSink,
} from '../../src/ui/printer'

describe('ui/printer', () => {
  it('Given tui mode, chat metadata keeps routing prefixes', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
      },
      'tui'
    )

    printer.chatAssistant('hello')
    printer.chatMeta('retrieval', 'hybrid')
    printer.chatMeta('sources', 'doc-1')

    expect(lines).toEqual(['assistant> hello', 'retrieval> hybrid', 'sources> doc-1'])
  })

  it('Given tui mode, separator routes as orchestration meta', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
      },
      'tui'
    )
    printer.separator()
    expect(lines).toEqual(['sep> —'])
  })

  it('Given cli mode without tty, metadata uses orchestration wire lines', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
      },
      'cli'
    )

    printer.metadata('match_ids', 'doc-a, doc-b')
    printer.thought('stage:hit->return')

    expect(lines[0]).toBe('match_ids> doc-a, doc-b')
    expect(lines[1]).toBe('thinking> stage:hit->return')
  })

  it('Given a progress sink, transient progress and clear route to it (not the transcript)', () => {
    const lines: string[] = []
    const progress: Array<string | null> = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
        progress: line => progress.push(line),
      },
      'tui'
    )

    printer.progress('thinking about it')
    printer.clearProgress()

    // Progress is transient — it must never land in the permanent transcript.
    expect(lines).toEqual([])
    expect(progress).toEqual(['thinking about it', null])
  })

  it('Given no progress sink in tui mode, progress is dropped (no transcript spam)', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        write: line => lines.push(line),
        error: line => lines.push(line),
      },
      'tui'
    )

    printer.progress('reasoning…')
    printer.clearProgress()

    expect(lines).toEqual([])
  })

  it('condenseProgressText folds whitespace and tail-truncates to the latest text', () => {
    expect(condenseProgressText('  a\n b  c \n')).toBe('a b c')
    const long = 'x'.repeat(200)
    const out = condenseProgressText(long, 10)
    expect(out.length).toBe(10)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('x')).toBe(true)
  })

  it('createReasoningProgressSink accumulates deltas and pushes the running tail', () => {
    const progress: Array<string | null> = []
    const printer = createPrinter(
      {
        log: () => {},
        write: () => {},
        error: () => {},
        progress: line => progress.push(line),
      },
      'tui'
    )

    const sink = createReasoningProgressSink(printer)
    sink('Let me ')
    sink('check the ')
    sink('facts.')

    expect(progress).toEqual(['Let me', 'Let me check the', 'Let me check the facts.'])
  })
})
