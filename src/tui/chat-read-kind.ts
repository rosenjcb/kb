export type ChatReadKind = 'chat' | 'command'

/**
 * Distinguish the idle chat prompt (`you>`) from command/interview prompts
 * like init questions. Only idle chat turns should create the generic
 * "thinking..." pending spinner.
 */
export function classifyChatReadPromptKind(prompt: string): ChatReadKind {
  const normalized = prompt.replace(/\r/g, '').trim()
  const firstLine =
    normalized
      .split('\n')
      .find(line => line.trim().length > 0)
      ?.trim() ?? ''

  return /^you\s*>?\s*$/i.test(firstLine) ? 'chat' : 'command'
}

export function shouldStartChatPending(input: {
  isSlash: boolean
  readKind: ChatReadKind
}): boolean {
  return !input.isSlash && input.readKind === 'chat'
}
