import { Box, Static } from 'ink'
import type { HistoryEntry } from '../types.js'
import { HistoryEntryRow } from './HistoryEntryRow.js'

interface Props {
  entries: HistoryEntry[]
}

/**
 * Completed rows go through `<Static>` so they stay in terminal scrollback; rows
 * with `loading: true` render below and update in place until finished.
 */
export function HistoryPane({ entries }: Props) {
  const staticItems = entries.filter(e => !e.loading)
  const liveItems = entries.filter(e => e.loading)

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {item => (
          <Box key={item.id} flexDirection="column" paddingX={1}>
            <HistoryEntryRow entry={item} />
          </Box>
        )}
      </Static>
      {liveItems.length > 0 ? (
        <Box flexDirection="column" paddingX={1}>
          {liveItems.map(entry => (
            <HistoryEntryRow key={entry.id} entry={entry} />
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
