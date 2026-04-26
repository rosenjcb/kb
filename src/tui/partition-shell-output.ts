import { isOrchestrationMetaLine } from '../ui/orchestration-meta.js'

export type ShellTuiSegment = { kind: 'body'; text: string } | { kind: 'meta'; line: string }

/**
 * Split captured `kb …` stdout for TUI shell history: primary prose vs orchestration `key> value` rows.
 * Keeps segment order stable so the UI can render body as `result` and meta as dim `chat-meta`.
 */
export function partitionShellOutputForTui(output: string): {
  segments: ShellTuiSegment[]
  /** When {@link segments} has no body chunks, use this string for the primary result slot. */
  emptyPrimaryContent: string
} {
  const lines = output.length > 0 ? output.split('\n') : ['']
  const segments: ShellTuiSegment[] = []
  let buf: string[] = []

  const flushBody = () => {
    const text = buf.join('\n').trimEnd()
    buf = []
    if (text === '') return
    segments.push({ kind: 'body', text })
  }

  for (const line of lines) {
    if (isOrchestrationMetaLine(line)) {
      flushBody()
      segments.push({ kind: 'meta', line })
    } else {
      buf.push(line)
    }
  }
  flushBody()

  const hasNonMeta = lines.some(l => l.trim() !== '' && !isOrchestrationMetaLine(l))
  const emptyPrimaryContent = hasNonMeta ? output.trim() : ''

  return { segments, emptyPrimaryContent }
}
