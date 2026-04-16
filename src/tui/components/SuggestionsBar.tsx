import { Box, Text } from 'ink'
import { getSuggestionWindow } from '../slash-commands.js'
import { BLUE, ORANGE } from '../theme.js'
import type { SlashCommand } from '../slash-commands.js'
import type { TuiMode } from '../types.js'

interface Props {
  suggestions: SlashCommand[]
  mode: TuiMode
  selectedIndex: number
}

export function SuggestionsBar({ suggestions, mode, selectedIndex }: Props) {
  const accent = mode === 'chat' ? ORANGE : BLUE
  const { visible: visibleSuggestions, startIndex } = getSuggestionWindow(suggestions, selectedIndex, 4)
  const reservedRows = visibleSuggestions.length === 0 ? 1 : visibleSuggestions.length
  const emptyRows = Math.max(0, 4 - reservedRows)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="single" borderColor={accent} flexDirection="column" paddingX={1}>
        <Text color="gray">slash commands — ↑/↓ to navigate, Tab to complete</Text>
        {visibleSuggestions.map((suggestion, index) => {
          const absoluteIndex = startIndex + index
          const isSelected = absoluteIndex === selectedIndex
          return (
            <Text key={suggestion.command} backgroundColor={isSelected ? 'gray' : undefined}>
              <Text color={isSelected ? 'black' : accent} bold>
                {isSelected ? '› ' : '  '}
              </Text>
              <Text color={isSelected ? 'black' : accent} bold>
              {suggestion.command}
              </Text>
              <Text color={isSelected ? 'black' : 'gray'}> — {suggestion.description}</Text>
            </Text>
          )
        })}
        {visibleSuggestions.length === 0 ? (
          <Text color="gray">  Type `/` to browse available commands</Text>
        ) : null}
        {Array.from({ length: emptyRows }, (_, index) => (
          <Text key={`empty-row-${index}`}>{' '}</Text>
        ))}
      </Box>
    </Box>
  )
}
