import { describe, expect, it } from 'vitest'
import {
  condenseProgressText,
  createPrinter,
  createReasoningProgressSink,
} from '@kb/client/ui/printer.js'

describe('ui/printer', () => {
  it('[TC-3ECA] Given tui mode, chat metadata keeps routing prefixes', () => {
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

  it('[TC-94KG] Given tui mode, separator routes as orchestration meta', () => {
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

  it('[TC-33UP] Given cli mode without tty, metadata uses orchestration wire lines', () => {
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

  it('[TC-54BT] Given a progress sink, transient progress and clear route to it (not the transcript)', () => {
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

  it('[TC-P6EW] Given no progress sink in tui mode, progress is dropped (no transcript spam)', () => {
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

  it('[TC-P9QS] condenseProgressText folds whitespace and tail-truncates to the latest text', () => {
    expect(condenseProgressText('  a\n b  c \n')).toBe('a b c')
    const long = 'x'.repeat(200)
    const out = condenseProgressText(long, 10)
    expect(out.length).toBe(10)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('x')).toBe(true)
  })

  it('[TC-RCVU] createReasoningProgressSink accumulates deltas and pushes the running tail', () => {
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

  describe('sourceCitation hyperlinks', () => {
    const OSC8 = (label: string, href: string) => `\x1b]8;;${href}\x07${label}\x1b]8;;\x07`

    /** Stub `process.stdout.isTTY` for one call, then restore it exactly. */
    function withTTY<T>(value: boolean, fn: () => T): T {
      const original = process.stdout.isTTY
      Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
      try {
        return fn()
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true })
      }
    }

    it('[TC-H4KX] Given cli mode on a real TTY, a source with an href renders as an OSC-8 hyperlink', () => {
      const lines: string[] = []
      withTTY(true, () => {
        const printer = createPrinter(
          { log: l => lines.push(l), write: l => lines.push(l), error: l => lines.push(l) },
          'cli'
        )
        printer.sourceCitation('src/a.ts', { href: 'https://github.com/rosenjcb/kb/blob/main/src/a.ts' })
      })
      expect(lines).toEqual([
        `source> ${OSC8('src/a.ts', 'https://github.com/rosenjcb/kb/blob/main/src/a.ts')}`,
      ])
    })

    it('[TC-QQ2M] Given tui mode on a real TTY, a source with an href also renders as an OSC-8 hyperlink — the Ink chat REPL links the same as kb query', () => {
      const lines: string[] = []
      withTTY(true, () => {
        const printer = createPrinter(
          { log: l => lines.push(l), write: l => lines.push(l), error: l => lines.push(l) },
          'tui'
        )
        printer.sourceCitation('src/a.ts', {
          href: 'https://github.com/rosenjcb/kb/blob/main/src/a.ts',
          symbols: ['foo'],
        })
      })
      expect(lines).toEqual([
        `source> ${OSC8('src/a.ts', 'https://github.com/rosenjcb/kb/blob/main/src/a.ts')} · foo`,
      ])
      // The `source>` prefix itself must stay unwrapped, or the TUI's
      // isOrchestrationMetaLine `^key>` classifier would miss the line.
      expect(lines[0].startsWith('source> ')).toBe(true)
    })

    it('[TC-9EAF] Given no real TTY (piped CLI or headless tui), the label stays plain — no escape bytes in captured output', () => {
      for (const mode of ['cli', 'tui'] as const) {
        const lines: string[] = []
        withTTY(false, () => {
          const printer = createPrinter(
            { log: l => lines.push(l), write: l => lines.push(l), error: l => lines.push(l) },
            mode
          )
          printer.sourceCitation('src/a.ts', { href: 'https://github.com/rosenjcb/kb/blob/main/src/a.ts' })
        })
        expect(lines).toEqual(['source> src/a.ts'])
      }
    })

    it('[TC-KZ1R] Given no href, the label stays plain even on a real TTY', () => {
      const lines: string[] = []
      withTTY(true, () => {
        const printer = createPrinter(
          { log: l => lines.push(l), write: l => lines.push(l), error: l => lines.push(l) },
          'cli'
        )
        printer.sourceCitation('src/a.ts', { symbols: ['foo', 'bar'] })
      })
      expect(lines).toEqual(['source> src/a.ts · foo, bar'])
    })
  })
})
