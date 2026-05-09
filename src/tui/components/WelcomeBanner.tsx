import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { BLUE, ORANGE } from '../theme.js'

const BANNER_LINES = [
  '██╗  ██╗██████╗',
  '██║ ██╔╝██╔══██╗',
  '█████╔╝ ██████╔╝',
  '██╔═██╗ ██╔══██╗',
  '██║  ██╗██████╔╝',
]

interface Props {
  providerLabel?: string
}

export function WelcomeBanner({ providerLabel }: Props) {
  const [cursorOn, setCursorOn] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => {
      setCursorOn(current => !current)
    }, 500)

    return () => clearInterval(interval)
  }, [])

  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_LINES.map(line => (
        <Text key={line} color={BLUE} bold>
          {line}
          {line === BANNER_LINES[2] ? (
            <Text color={ORANGE}>{cursorOn ? '  [█]' : '  [ ]'}</Text>
          ) : null}
        </Text>
      ))}
      <Text color="gray">A Knowledge Base for your Agent — type a question or /help for commands</Text>
      {providerLabel ? (
        <Text color="gray">using <Text color={ORANGE}>{providerLabel}</Text></Text>
      ) : null}
    </Box>
  )
}
