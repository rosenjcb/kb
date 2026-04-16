import { Box, Text } from 'ink'
import { BLUE, ORANGE } from '../theme.js'
import type { TuiMode } from '../types.js'

interface Props {
  baseName: string
  mode: TuiMode
}

export function StatusBar({ baseName, mode }: Props) {
  return (
    <Box borderStyle="single" borderColor={BLUE} paddingX={1}>
      <Text bold color={BLUE}>
        KB Agent
      </Text>
      <Text color="gray"> │ </Text>
      <Text color="gray">base: </Text>
      <Text color={ORANGE}>{baseName}</Text>
      <Text color="gray"> │ </Text>
      <Text color="gray">mode: </Text>
      <Text color={mode === 'chat' ? ORANGE : BLUE}>{mode}</Text>
    </Box>
  )
}
