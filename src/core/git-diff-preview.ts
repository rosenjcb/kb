import chalk from 'chalk'
import { createPatch } from 'diff'

export function createUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  options: { context?: number } = {}
): string {
  const context = options.context ?? 3
  return createPatch(filePath, before, after, '', '', { context })
}

export function colorizeUnifiedDiff(patch: string, options: { color?: boolean } = {}): string {
  const useColor = options.color ?? true
  if (!useColor) return patch
  const lines = patch.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      out.push(chalk.dim(line))
    } else if (line.startsWith('@@')) {
      out.push(chalk.cyan(line))
    } else if (line.startsWith('+')) {
      out.push(chalk.green(line))
    } else if (line.startsWith('-')) {
      out.push(chalk.red(line))
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

export function renderNewFileDiff(filePath: string, content: string): string {
  return createUnifiedDiff(filePath, '', content)
}

/** @deprecated Prefer {@link createUnifiedDiff}; kept for rescan preview call sites. */
export function renderTextDiff(filePath: string, before: string, after: string): string {
  return createUnifiedDiff(filePath, before, after)
}

export function renderDiffBundle(sections: string[], emptyMessage: string): string {
  return sections.length > 0 ? sections.join('\n\n') : emptyMessage
}
