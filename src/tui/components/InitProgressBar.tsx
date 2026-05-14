import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { BLUE } from '../theme.js'

interface Props {
  line: string
}

export function InitProgressBar({ line }: Props) {
  return (
    <Box paddingX={1}>
      <Text color={BLUE}>
        <Spinner type="dots" />
        {'  '}
      </Text>
      <Text color="gray" dimColor>
        {line}
      </Text>
    </Box>
  )
}
