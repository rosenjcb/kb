import { Text } from 'ink'
import Spinner from 'ink-spinner'
import { BLUE } from '../theme.js'

export function LoadingSpinner() {
  return (
    <Text color={BLUE}>
      <Spinner type="dots" />
      {' running…'}
    </Text>
  )
}
