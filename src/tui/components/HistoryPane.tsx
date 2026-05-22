import { Box, Static } from 'ink'
import type { HistoryEntry } from '../types.js'
import { HistoryEntryRow } from './HistoryEntryRow.js'

interface Props {
  entries: HistoryEntry[]
}

/** Split committed transcript rows from in-flight loading rows. */
export function partitionHistoryEntries(entries: HistoryEntry[]): {
  staticItems: HistoryEntry[]
  liveItems: HistoryEntry[]
} {
  const staticItems: HistoryEntry[] = []
  const liveItems: HistoryEntry[] = []
  for (const entry of entries) {
    if (entry.loading) liveItems.push(entry)
    else staticItems.push(entry)
  }
  return { staticItems, liveItems }
}

/**
 * Completed rows go through `<Static>` so they stay in terminal scrollback; rows
 * with `loading: true` render below and update in place until finished.
 */
export function HistoryPane({ entries }: Props) {
  const { staticItems, liveItems } = partitionHistoryEntries(entries)

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
