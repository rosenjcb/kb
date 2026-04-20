import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import type { CliOutput } from '../cli/index.js'
import type { CmdMode } from '../cli/cmd-ref.js'

// ---------------------------------------------------------------------------
// Printer — centralized output layer for all kb CLI commands
//
// TTY CLI: chalk colors + ora spinner
// Piped / non-TTY CLI: plain text, no spinner
// TUI mode: no-op spinner, no chalk (TUI owns its own rendering via Ink)
// ---------------------------------------------------------------------------

export class Printer {
  private spinner: Ora | null = null
  private readonly tty: boolean

  constructor(
    private readonly out: CliOutput,
    private readonly mode: CmdMode
  ) {
    this.tty = mode === 'cli' && !!process.stdout.isTTY
  }

  // Main answer / response body — always first, always plain white
  content(text: string): void {
    this.out.log(text)
  }

  // Agent internality: checkpoint traces, planning steps, thinking states
  // TTY: dim italic wrapped in parens
  // Plain: same text, no styling
  thought(text: string): void {
    const normalized = text.trim()
    if (!normalized) return
    if (this.tty) {
      this.out.log(chalk.dim.italic(`(${normalized})`))
    } else {
      this.out.log(`(${normalized})`)
    }
  }

  // Structured metadata line below the answer separator
  // TTY: bold cyan label + dim value
  // Plain: "Label: value"
  metadata(label: string, value: string): void {
    const key = normalizeLabel(label)
    if (this.tty) {
      this.out.log(`${chalk.bold.cyan(`${key}:`)} ${chalk.dim(value)}`)
    } else {
      this.out.log(`${key}: ${value}`)
    }
  }

  // Chat-mode metadata: preserves the "retrieval> / sources>" prefix protocol
  // that App.tsx uses to route lines to chat-meta (dim gray) entries in the TUI.
  // TTY CLI: styled same as metadata()
  chatMeta(label: string, value: string): void {
    if (this.mode === 'tui') {
      this.out.write(`${label.toLowerCase()}> ${value}`)
    } else {
      this.metadata(label, value)
    }
  }

  chatAssistant(text: string): void {
    const normalized = text.trim()
    if (!normalized) return
    if (this.mode === 'tui') {
      this.out.write(`assistant> ${normalized}`)
      return
    }
    if (this.tty) {
      this.content(normalized)
      return
    }
    this.out.write(`assistant> ${normalized}`)
  }

  // Source provenance line
  source(id: string, title?: string): void {
    const display = title ? `${id} — ${title}` : id
    if (this.tty) {
      this.out.log(`  ${chalk.dim(display)}`)
    } else {
      this.out.log(`  ${display}`)
    }
  }

  // Horizontal rule between content and metadata
  separator(): void {
    if (this.tty) {
      this.out.log(chalk.dim('---'))
    } else {
      this.out.log('---')
    }
  }

  // Status line: yellow in TTY, plain otherwise
  status(text: string): void {
    if (this.tty) {
      this.out.log(chalk.yellow(text))
    } else {
      this.out.log(text)
    }
  }

  // ---------------------------------------------------------------------------
  // Spinner — wraps LLM invocations and agent loop calls
  // ---------------------------------------------------------------------------

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

  // Stop spinner and show a completion tick
  succeedSpinner(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text)
      this.spinner = null
    }
  }

  // Stop spinner and show a failure cross
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

function normalizeLabel(s: string): string {
  if (!s) return s
  return s
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}
