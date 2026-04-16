import { Text } from 'ink'
import { BLUE, ORANGE } from '../theme.js'
import type { HistoryEntry } from '../types.js'
import { LoadingSpinner } from './LoadingSpinner.js'

interface Props {
  entry: HistoryEntry
}

export function HistoryEntryRow({ entry }: Props) {
  if (entry.loading) {
    return <LoadingSpinner />
  }

  switch (entry.type) {
    case 'command':
      return <Text color={ORANGE}>{entry.content}</Text>

    case 'chat-you':
      return (
        <Text>
          <Text color={ORANGE} bold>
            you&gt;{' '}
          </Text>
          <Text>{entry.content}</Text>
        </Text>
      )

    case 'chat-assistant':
      return (
        <Text>
          <Text color={BLUE} bold>
            kb&gt;{' '}
          </Text>
          <Text>{entry.content}</Text>
        </Text>
      )

    case 'error':
      return <Text color="red">{entry.content}</Text>

    case 'info':
      return <Text color="gray">{entry.content}</Text>

    case 'result':
      return <Text>{entry.content}</Text>

    default:
      return <Text>{entry.content}</Text>
  }
}
