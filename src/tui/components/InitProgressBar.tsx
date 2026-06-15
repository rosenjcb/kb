import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { parseInitProgressLine } from '../init-progress-line.js'
import { BLUE, ORANGE } from '../theme.js'

interface Props {
  line: string | null
  /** True when work is in flight but no progress text has arrived yet. */
  idle?: boolean
}

export function InitProgressBar({ line, idle = false }: Props) {
  const trimmed = line?.trim()
  if (!trimmed) {
    if (!idle) return null
    return (
      <Box paddingX={1}>
        <Text color={BLUE}>
          <Spinner type="dots" />
          {' running…'}
        </Text>
      </Box>
    )
  }

  const { repo, body } = parseInitProgressLine(trimmed)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {repo ? (
        <Text bold color={ORANGE}>
          repo: {repo}
        </Text>
      ) : null}
      <Text bold>{body}</Text>
    </Box>
  )
}
