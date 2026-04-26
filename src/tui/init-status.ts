export interface InitStatusState {
  message?: string
  progressLine?: string
  actionLine?: string
}

export interface ParsedInitOutput {
  historyLines: string[]
  progressLine?: string
  actionLine?: string
}

export function parseInitOutput(message: string): ParsedInitOutput {
  const historyLines: string[] = []
  let progressLine: string | undefined
  let actionLine: string | undefined

  for (const rawLine of message.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('[init:action]')) {
      actionLine = line
      historyLines.push(line)
      continue
    }

    if (line.startsWith('[init]')) {
      progressLine = line
      continue
    }

    historyLines.push(line)
  }

  return { historyLines, progressLine, actionLine }
}
