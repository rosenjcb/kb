import { Box } from 'ink'
import type { HistoryEntry } from '../types.js'
import { HistoryEntryRow } from './HistoryEntryRow.js'

interface Props {
  entries: HistoryEntry[]
}

export function HistoryPane({ entries }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {entries.map(entry => (
        <HistoryEntryRow key={entry.id} entry={entry} />
      ))}
    </Box>
  )
}
