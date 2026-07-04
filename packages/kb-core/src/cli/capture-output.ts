import type { CliOutput } from '@kb/core/ui/cli-output.js'

export interface CaptureOutput {
  output: CliOutput
  text(): string
  errorText(): string
  hadError(): boolean
}

export function createCaptureOutput(): CaptureOutput {
  const lines: string[] = []
  const errors: string[] = []
  return {
    output: {
      log: message => lines.push(message),
      error: message => errors.push(message),
      write: chunk => lines.push(chunk),
      progress: line => {
        if (line) lines.push(line)
      },
    },
    text: () => lines.join('\n'),
    errorText: () => errors.join('\n'),
    hadError: () => errors.length > 0,
  }
}
