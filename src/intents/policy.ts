export const INTERNAL_OPERATION_TOOL_NAMES = new Set([
  'read_facts',
  'upsert_fact',
  'invalidate_fact',
  'invalidate_graph_for_fact',
  'upsert_graph_from_text',
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
      `Direct internal tool invocation is blocked in consumer mode: ${firstArg}. Use intent commands (submit|query|invalidate).`
    )
  }
}
