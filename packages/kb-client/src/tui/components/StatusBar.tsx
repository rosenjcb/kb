import { Box, Text } from 'ink'
import { BLUE, ORANGE } from '../theme.js'

interface Props {
  serverHost: string
  baseName: string
  /** True when baseName is the server's own default base (no local active base). */
  baseIsServerDefault?: boolean
}

export function StatusBar({ serverHost, baseName, baseIsServerDefault }: Props) {
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
      {baseName && baseIsServerDefault ? <Text color="gray"> (server default)</Text> : null}
    </Box>
  )
}
