import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { BLUE } from '../theme.js'

export const SPINNER_MAX_LINES = 6
export const SPINNER_MAX_LINE_LEN = 100

/**
 * Extract the last N non-empty lines from streaming status for grey context display.
 * Pure function — exported for testing.
 */
export function truncateStatusLines(
  status: string | undefined,
  maxLines = SPINNER_MAX_LINES,
  maxLineLen = SPINNER_MAX_LINE_LEN
): string[] {
  if (!status) return []
  return status
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim())
    .slice(-maxLines)
    .map(l => (l.length > maxLineLen ? `${l.slice(0, maxLineLen - 1)}…` : l))
}

/**
 * Uniform loading indicator used everywhere an async operation is in progress (T2 progress tier).
 * Shows a blue spinner + the last few lines of streaming content in grey/dim.
 * Content is capped to avoid scrolling into terminal scrollback.
 */
export function LoadingSpinner({ status }: { status?: string }) {
  const lines = truncateStatusLines(status)

  return (
    <Box flexDirection="column">
      <Text color={BLUE}>
        <Spinner type="dots" />
        {' running…'}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color="gray" dimColor>
          {line}
        </Text>
      ))}
    </Box>
  )
}
