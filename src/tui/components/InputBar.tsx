import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { ORANGE } from '../theme.js'
import type { TuiMode } from '../types.js'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  mode: TuiMode
  isRunning: boolean
  /** Shown in the text field when chat is waiting on a sub-prompt (e.g. docs generate). */
  chatPlaceholder?: string
}

export function InputBar({
  value,
  onChange,
  onSubmit,
  isRunning,
  chatPlaceholder = '',
}: Props) {
  const placeholder = isRunning ? '(running…)' : chatPlaceholder || ''

  return (
    <Box borderStyle="single" borderColor={isRunning ? 'gray' : ORANGE} paddingX={1}>
      <Text color={ORANGE} bold>
        you&gt;{' '}
      </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
    </Box>
  )
}
