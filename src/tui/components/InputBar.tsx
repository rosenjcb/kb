import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { BLUE, ORANGE } from '../theme.js'
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
  mode,
  isRunning,
  chatPlaceholder = '',
}: Props) {
  const isChat = mode === 'chat'
  const isInit = mode === 'init'
  const borderColor = isRunning ? 'gray' : isChat || isInit ? ORANGE : BLUE
  const promptColor = isChat || isInit ? ORANGE : BLUE
  const prompt = isChat ? 'you' : isInit ? 'ans' : 'kb'
  const placeholder = isRunning ? '(running…)' : isChat && chatPlaceholder ? chatPlaceholder : ''

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor} bold>
        {prompt}&gt;{' '}
      </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
    </Box>
  )
}
