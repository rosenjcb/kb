import { Box, Text } from 'ink'
import type { InitStatusState } from '../init-status.js'
import { ORANGE } from '../theme.js'

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
        <Text color="gray">{status.actionLine ?? '[status] waiting for next step…'}</Text>
        <Text color={ORANGE}>
          {status.progressLine ?? '[status] waiting for first progress update…'}
        </Text>
      </Box>
    </Box>
  )
}
