import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const promptsDir = dirname(fileURLToPath(import.meta.url))

/**
 * Load a prompt file from src/prompts/ as a trimmed string.
 */
export function loadPrompt(name: string): string {
  return readFileSync(join(promptsDir, name), 'utf8').trim()
}

/**
 * Load a two-part prompt file that uses `\n---\n` as the divider between
 * the intro (role/context) and the instructions (task rules).
 *
 * Throws if no `---` divider is found.
 */
export function loadPromptParts(name: string): { intro: string; instructions: string } {
  const text = loadPrompt(name)
  const idx = text.indexOf('\n---\n')
  if (idx === -1) {
    throw new Error(
      `Prompt file "${name}" is missing the \\n---\\n divider between intro and instructions.`
    )
  }
  return {
    intro: text.slice(0, idx).trim(),
    instructions: text.slice(idx + 5).trim(),
  }
}
