import { Box, Text } from 'ink'
import { BASE_FALLBACK_SUFFIX } from '../../api/server-connection.js'
import { BLUE, ORANGE } from '../theme.js'

interface Props {
  serverHost: string
  baseName: string
  /** True when baseName is the client's own unconfigured fallback (no local active base). */
  baseIsFallback?: boolean
}

export function StatusBar({ serverHost, baseName, baseIsFallback }: Props) {
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
      {baseName && baseIsFallback ? <Text color="gray">{BASE_FALLBACK_SUFFIX}</Text> : null}
    </Box>
  )
}
