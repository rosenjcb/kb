import { Box } from 'ink'
import type { HistoryEntry } from '../types.js'
import { HistoryEntryRow } from './HistoryEntryRow.js'

interface Props {
  entries: HistoryEntry[]
}

export function HistoryPane({ entries }: Props) {
  return (
    <Box flexDirection="column">
      {entries.map(entry => (
        <Box key={entry.id} flexDirection="column" paddingX={1}>
          <HistoryEntryRow entry={entry} />
        </Box>
      ))}
    </Box>
  )
}
