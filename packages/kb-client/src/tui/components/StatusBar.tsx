import { Box, Text } from 'ink'
import { BLUE, ORANGE } from '../theme.js'

interface Props {
  serverHost: string
  baseName: string
}

export function StatusBar({ serverHost, baseName }: Props) {
  return (
    <Box borderStyle="single" borderColor={BLUE} paddingX={1}>
      <Text bold color={BLUE}>
        KB Agent
      </Text>
      <Text color="gray"> │ </Text>
      <Text color="gray">host: </Text>
      <Text color={ORANGE}>{serverHost || '(unknown)'}</Text>
      <Text color="gray"> │ </Text>
      <Text color="gray">base: </Text>
      <Text color={ORANGE}>{baseName || '(none)'}</Text>
    </Box>
  )
}
