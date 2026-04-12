export const INTERNAL_OPERATION_TOOL_NAMES = new Set([
  'write_document',
  'append_to_document',
  'update_document',
  'merge_documents',
  'prune_document',
  'read_documents',
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
      `Direct internal tool invocation is blocked in consumer mode: ${firstArg}. Use intent commands (submit|validate|dispute|query|explain).`,
    )
  }
}
