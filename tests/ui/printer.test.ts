import { describe, expect, it } from 'vitest'
import { createPrinter } from '../../src/ui/printer'

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
})
