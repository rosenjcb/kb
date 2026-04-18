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
}

export function InputBar({ value, onChange, onSubmit, mode, isRunning }: Props) {
  const isChat = mode === 'chat'
  const isInit = mode === 'init'
  const borderColor = isRunning ? 'gray' : isChat || isInit ? ORANGE : BLUE
  const promptColor = isChat || isInit ? ORANGE : BLUE
  const prompt = isChat ? 'you' : isInit ? 'ans' : 'kb'

  return (
    <Box borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={promptColor} bold>
        {prompt}&gt;{' '}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={isRunning ? '(running…)' : ''}
      />
    </Box>
  )
}
