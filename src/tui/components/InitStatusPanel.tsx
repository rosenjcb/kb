import { Box, Text } from 'ink'
import { ORANGE } from '../theme.js'
import type { InitStatusState } from '../init-status.js'

interface Props {
  status: InitStatusState
  visible: boolean
}

export function InitStatusPanel({ status, visible }: Props) {
  if (!visible) return null

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="single" borderColor={ORANGE} flexDirection="column" paddingX={1}>
        <Text color="gray">init status</Text>
        <Text color="gray">{status.message ?? 'Initializing KB…'}</Text>
        <Text color={ORANGE}>{status.progressLine ?? '[init] waiting for first progress update…'}</Text>
      </Box>
    </Box>
  )
}
