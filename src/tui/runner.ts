import type { KbConfig } from '../cli/kb-config.js'

// Lazy-load index.ts so its top-level main() call doesn't fire just from
// importing runner.ts (which chat-cli pulls in via chat-docs-generate-flow).
async function loadIndex() {
  return import('../cli/index.js')
}

export async function printCliHelp(): Promise<string> {
  const { printCliHelp: impl } = await loadIndex()
  return impl()
}

/**
 * Run a CLI command and return its output as a string.
 * Used by the TUI to display results inline without spawning a new process.
 */
export async function runCommandForTui(
  args: string[],
  config: KbConfig,
  onChunk?: (line: string) => void,
  sessionId?: string
): Promise<string> {
  const { runMainWithOutput } = await loadIndex()
  const chunks: string[] = []

  const out = {
    log: (msg: string) => {
      chunks.push(msg)
      onChunk?.(msg)
    },
    error: (msg: string) => {
      chunks.push(msg)
      onChunk?.(msg)
    },
    write: (chunk: string) => {
      chunks.push(chunk)
      onChunk?.(chunk)
    },
  }

  try {
    await runMainWithOutput(args, out, config, 'tui', sessionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    chunks.push(message)
  }

  return chunks
    .map(s => s.trimEnd())
    .filter(s => s.length > 0)
    .join('\n')
    .trim()
}

/**
 * Parse a shell-style command string into an argument array.
 * Handles single and double quoted strings.
 * e.g. `query "what is the project?"` → ['query', 'what is the project?']
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (const char of input) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false
        args.push(current)
        current = ''
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      if (current) {
        args.push(current)
        current = ''
      }
      inQuote = true
      quoteChar = char
    } else if (char === ' ') {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) args.push(current)
  return args
}
