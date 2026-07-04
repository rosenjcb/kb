export const INTERNAL_OPERATION_TOOL_NAMES = new Set([
  'read_facts',
  'upsert_fact',
  'task',
])

export function isDirectInternalToolInvocation(input: string): boolean {
  return INTERNAL_OPERATION_TOOL_NAMES.has(input.trim())
}

export function shouldAllowDirectInternalTools(): boolean {
  return (process.env.KB_ALLOW_INTERNAL_TOOLS || '').toLowerCase() === 'true'
}

export function assertConsumerSafeCommand(firstArg: string): void {
  if (shouldAllowDirectInternalTools()) {
    return
  }

  if (isDirectInternalToolInvocation(firstArg)) {
    throw new Error(
      `Direct internal tool invocation is blocked in consumer mode: ${firstArg}. Use kb query.`
    )
  }
}
