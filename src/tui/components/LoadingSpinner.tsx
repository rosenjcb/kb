import { Text } from 'ink'
import Spinner from 'ink-spinner'
import { BLUE } from '../theme.js'

export function LoadingSpinner({ status }: { status?: string }) {
  return (
    <Text color={BLUE}>
      <Spinner type="dots" />
      {status ? ` ${status}` : ' running…'}
    </Text>
  )
}
