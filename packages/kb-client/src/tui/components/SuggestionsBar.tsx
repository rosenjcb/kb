import { Box, Text } from 'ink'
import { slashCommandGroupLabel } from '@kb/core/commands/command-catalog.js'
import { getSuggestionWindow } from '../slash-commands.js'
import type { SlashCommand } from '../slash-commands.js'
import { BLUE, ORANGE } from '../theme.js'
import type { TuiMode } from '../types.js'

interface Props {
  suggestions: SlashCommand[]
  mode: TuiMode
  selectedIndex: number
}

/** '/facts list' → 'facts'; used to look up a suggestion's menu section. */
function topLevelName(command: string): string {
  return command.replace(/^\//, '').split(' ')[0] ?? ''
}

function SuggestionRow({
  suggestion,
  isSelected,
  accent,
  indent,
}: {
  suggestion: SlashCommand
  isSelected: boolean
  accent: string
  indent: boolean
}) {
  return (
    <Text backgroundColor={isSelected ? 'gray' : undefined}>
      <Text color={isSelected ? 'black' : accent} bold>
        {isSelected ? (indent ? '  › ' : '› ') : indent ? '    ' : '  '}
      </Text>
      <Text color={isSelected ? 'black' : accent} bold>
        {suggestion.command}
      </Text>
      <Text color={isSelected ? 'black' : 'gray'}> — {suggestion.description}</Text>
    </Text>
  )
}

export function SuggestionsBar({ suggestions, mode, selectedIndex }: Props) {
  const accent = mode === 'chat' ? ORANGE : BLUE

  if (suggestions.length === 0) return null

  // Grouped menu: when the suggestions are all top-level commands (no subcommand or bare
  // base-name entries), show the full set divided into the catalog's sections. Filtered or
  // subcommand lists fall back to the compact scrolling window below.
  const isTopLevelMenu = suggestions.every(
    s => s.command.startsWith('/') && !s.command.includes(' ')
  )

  if (isTopLevelMenu) {
    let lastLabel: string | undefined
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Box borderStyle="single" borderColor={accent} flexDirection="column" paddingX={1}>
          <Text color="gray">slash commands — ↑/↓ to navigate, Tab to complete</Text>
          {suggestions.map((suggestion, index) => {
            const label = slashCommandGroupLabel(topLevelName(suggestion.command))
            const showHeader = label !== undefined && label !== lastLabel
            lastLabel = label
            return (
              <Box key={suggestion.command} flexDirection="column">
                {showHeader && (
                  <Text color="gray" bold>
                    {label}
                  </Text>
                )}
                <SuggestionRow
                  suggestion={suggestion}
                  isSelected={index === selectedIndex}
                  accent={accent}
                  indent
                />
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  }

  const { visible: visibleSuggestions, startIndex } = getSuggestionWindow(suggestions, selectedIndex, 4)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="single" borderColor={accent} flexDirection="column" paddingX={1}>
        <Text color="gray">slash commands — ↑/↓ to navigate, Tab to complete</Text>
        {visibleSuggestions.map((suggestion, index) => (
          <SuggestionRow
            key={suggestion.command}
            suggestion={suggestion}
            isSelected={startIndex + index === selectedIndex}
            accent={accent}
            indent={false}
          />
        ))}
      </Box>
    </Box>
  )
}
