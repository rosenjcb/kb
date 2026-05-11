import { Box, Text } from 'ink'
import { BLUE } from '../theme.js'

interface Props {
  line: string
}

export function InitProgressBar({ line }: Props) {
  return (
    <Box paddingX={1}>
      <Text color={BLUE}>{line}</Text>
    </Box>
  )
}
