import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { CLIENT_VERSION } from '../../version.js'
import { BLUE, ORANGE } from '../theme.js'

/** Keep in sync with assets/kb-ascii.txt (+ demo/kb-ascii.svg). */
const BANNER_LINES = [
  '██╗  ██╗██████╗',
  '██║ ██╔╝██╔══██╗',
  '█████╔╝ ██████╔╝',
  '██╔═██╗ ██╔══██╗',
  '██║  ██╗██████╔╝',
]

export function WelcomeBanner() {
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
      <Text color="gray">
        A Knowledge Base for your Agent{' '}
        <Text color={ORANGE}>v{CLIENT_VERSION}</Text>
        {' '}— type a question or /help for commands
      </Text>    </Box>
  )
}
