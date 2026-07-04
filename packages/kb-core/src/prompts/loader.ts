import { readPromptAssetUtf8 } from './prompt-assets'

/** Re-export for callers that need the directory; prefer importing from `./prompt-assets.js`. */
export { promptsRootDir, readPromptAssetUtf8, resolvePromptPath } from './prompt-assets'

/**
 * Load a top-level prompt file (`<name>.md` next to `doc-questionnaires/`) as a trimmed string.
 */
export function loadPrompt(name: string): string {
  return readPromptAssetUtf8(name).trim()
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
