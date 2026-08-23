import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import type { CmdMode } from '../config/cmd-ref.js'
import type { CliOutput } from './cli-output.js'
import { formatOrchestrationMetaLine } from './orchestration-meta.js'

/** OSC-8 terminal hyperlink: `ESC ] 8 ; ; URI BEL label ESC ] 8 ; ; BEL`. */
function terminalHyperlink(label: string, href: string): string {
  const ESC = '\x1b'
  const BEL = '\x07'
  return `${ESC}]8;;${href}${BEL}${label}${ESC}]8;;${BEL}`
}

export class Printer {
  private spinner: Ora | null = null
  private readonly tty: boolean
  private readonly hyperlinks: boolean

  constructor(
    private readonly out: CliOutput,
    private readonly mode: CmdMode
  ) {
    this.tty = mode === 'cli' && !!process.stdout.isTTY
    // Separate from `tty`: that flag also gates chalk.dim() styling of the whole
    // wire line (`orchestrationMeta`), and coloring the `source>` prefix itself
    // would break `isOrchestrationMetaLine`'s `^key>` match in the TUI's line
    // classifier. Hyperlinks are safe there — the OSC-8 bytes land only inside the
    // label a citation renders, after the prefix, same as CLI TTY mode. The Ink TUI
    // only ever starts against a real terminal (`index.ts` gates it on
    // `process.stdout.isTTY`), so `mode === 'tui'` already implies one; the isTTY
    // check stays for defense (e.g. a test harness constructing 'tui' headless).
    this.hyperlinks = this.tty || (mode === 'tui' && !!process.stdout.isTTY)
  }

  content(text: string): void {
    this.out.log(text)
  }

  thought(text: string): void {
    const normalized = text.trim()
    if (!normalized) return
    const line = formatOrchestrationMetaLine('thinking', normalized)
    if (this.tty) {
      this.out.log(chalk.dim(line))
    } else {
      this.out.log(line)
    }
  }

  orchestrationMeta(label: string, value: string): void {
    const line = formatOrchestrationMetaLine(label, value)
    if (this.tty) {
      this.out.log(chalk.dim(line))
    } else {
      this.out.log(line)
    }
  }

  metadata(label: string, value: string): void {
    this.orchestrationMeta(label, value)
  }

  chatMeta(label: string, value: string): void {
    this.orchestrationMeta(label, value)
  }

  chatAssistant(text: string): void {
    const normalized = text.trim()
    if (!normalized) return
    if (this.mode === 'tui') {
      this.out.log(formatOrchestrationMetaLine('assistant', normalized))
      return
    }
    if (this.tty) {
      this.content(normalized)
      return
    }
    this.out.log(formatOrchestrationMetaLine('assistant', normalized))
  }

  /**
   * One source-centric citation line: `label · sym1, sym2`, with the label made a
   * clickable OSC-8 hyperlink to the same blob `href` Slack and the chat demo
   * link to — same registry, same URL, just a terminal-native link instead of
   * Slack's `<url|label>` or the demo's `<a href>`. Displayed text stays the
   * filepath either way. Non-TTY (pipes, CI) gets the plain label so captured
   * output stays clean.
   */
  sourceCitation(label: string, opts: { href?: string; symbols?: string[] } = {}): void {
    const suffix = opts.symbols && opts.symbols.length > 0 ? ` · ${opts.symbols.join(', ')}` : ''
    const shown = opts.href && this.hyperlinks ? terminalHyperlink(label, opts.href) : label
    this.orchestrationMeta('Source', `${shown}${suffix}`)
  }

  separator(): void {
    if (this.mode === 'tui') {
      this.orchestrationMeta('sep', '—')
      return
    }
    if (this.tty) {
      this.out.log(chalk.dim('---'))
    } else {
      this.out.log('---')
    }
  }

  status(text: string): void {
    if (this.tty) {
      this.out.log(chalk.yellow(text))
    } else {
      this.out.log(text)
    }
  }

  progress(text: string): void {
    const line = condenseProgressText(text)
    if (!line) return
    if (this.out.progress) {
      this.out.progress(line)
      return
    }
    if (this.mode === 'tui') return
    if (this.tty) {
      if (this.spinner) {
        this.spinner.text = line
      } else {
        this.spinner = ora({ text: line, color: 'cyan', spinner: 'dots' }).start()
      }
    }
  }

  clearProgress(): void {
    if (this.out.progress) {
      this.out.progress(null)
      return
    }
    this.stopSpinner()
  }

  startSpinner(text = 'running…'): void {
    if (this.mode === 'tui') return

    if (this.tty) {
      this.stopSpinner()
      this.spinner = ora({ text, color: 'cyan', spinner: 'dots' }).start()
    } else {
      this.out.log(text)
    }
  }

  stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop()
      this.spinner = null
    }
  }

  succeedSpinner(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text)
      this.spinner = null
    }
  }

  failSpinner(text?: string): void {
    if (this.spinner) {
      this.spinner.fail(text)
      this.spinner = null
    }
  }
}

export function createPrinter(out: CliOutput, mode: CmdMode): Printer {
  return new Printer(out, mode)
}

export const PROGRESS_LINE_MAX_CHARS = 120

export function condenseProgressText(text: string, maxChars = PROGRESS_LINE_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `…${collapsed.slice(-(maxChars - 1))}`
}

export function createReasoningProgressSink(printer: Printer): (delta: string) => void {
  let buffer = ''
  return (delta: string) => {
    buffer += delta
    printer.progress(buffer)
  }
}
