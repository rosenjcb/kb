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

  // Status line: yellow in TTY, plain otherwise
  status(text: string): void {
    if (this.tty) {
      this.out.log(chalk.yellow(text))
    } else {
      this.out.log(text)
    }
  }

  // ---------------------------------------------------------------------------
  // Transient progress — streaming reasoning / "loading bar" text
  //
  // Unlike orchestrationMeta/content, progress lines REPLACE one another and vanish
  // when cleared. TUI routes them to its disappearing progress bar; TTY CLI folds them
  // into the live spinner text; piped output stays quiet (transient noise is dropped).
  // ---------------------------------------------------------------------------

  /** Show/replace the current transient progress line. */
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
    // non-TTY: drop transient progress (would spam piped output)
  }

  /** Clear the transient progress line (call when the awaited result arrives). */
  clearProgress(): void {
    if (this.out.progress) {
      this.out.progress(null)
      return
    }
    this.stopSpinner()
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

/** Max characters shown on a single transient progress line (tail-preserved). */
export const PROGRESS_LINE_MAX_CHARS = 120

/**
 * Collapse streaming text into a single bounded progress line: newlines/whitespace
 * folded to single spaces, trimmed, and tail-truncated so the most recent reasoning is
 * always visible. Pure — exported for testing.
 */
export function condenseProgressText(text: string, maxChars = PROGRESS_LINE_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `…${collapsed.slice(-(maxChars - 1))}`
}

/**
 * Build an `onReasoning` callback that streams a model's reasoning tokens onto the
 * printer's transient progress line. Reasoning accumulates so the line reflects the
 * latest tail; call {@link Printer.clearProgress} when the awaited result arrives.
 */
export function createReasoningProgressSink(printer: Printer): (delta: string) => void {
  let buffer = ''
  return (delta: string) => {
    buffer += delta
    printer.progress(buffer)
  }
}
