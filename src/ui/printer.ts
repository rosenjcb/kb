import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import type { CmdMode } from '../cli/cmd-ref.js'
import type { CliOutput } from '../cli/index.js'
import { formatOrchestrationMetaLine } from './orchestration-meta.js'

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

  // Agent internality: checkpoint traces, hints — same wire line family as orchestrationMeta
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

  /**
   * Intent-loop / tool orchestration metadata (retrieval, status, sources, …).
   * Always `wire_key> value` so TUI and piped CLI see the same structure.
   */
  orchestrationMeta(label: string, value: string): void {
    const line = formatOrchestrationMetaLine(label, value)
    if (this.tty) {
      this.out.log(chalk.dim(line))
    } else {
      this.out.log(line)
    }
  }

  /** @deprecated Prefer orchestrationMeta; kept for call sites that still say "metadata". */
  metadata(label: string, value: string): void {
    this.orchestrationMeta(label, value)
  }

  /** Same wire format as orchestrationMeta (chat historically used this name). */
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

  // Retrieved doc / provenance line (orchestration, not primary answer text)
  source(id: string, title?: string): void {
    const display = title ? `${id} — ${title}` : id
    this.orchestrationMeta('source', display)
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
