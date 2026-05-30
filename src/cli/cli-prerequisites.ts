/**
 * Single source of truth for user-facing prerequisite errors (KB base vs LLM).
 * Use these strings everywhere so CLI, TUI, and tests stay aligned.
 */

/** Shown when no effective KB base exists and no `--base` override applies. */
export const CLI_ERROR_NO_KB_BASE =
  'No knowledge base selected. Use `kb use <base>` or `kb use --default <base>`.'

/** Shown when an LLM provider cannot be constructed from config + environment. */
export const CLI_ERROR_NO_LLM_PROVIDER =
  'No LLM provider available. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in your environment, or run `kb config llm`.'

/** Non-interactive `kb init` without `--base` and without a saved default path. */
export const CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE = `${CLI_ERROR_NO_KB_BASE} For non-interactive init, pass \`kb init --base <name>\`.`

export function formatPrerequisiteError(message: string): string {
  return `❌ ${message}`
}

export function uninitializedBaseNotice(baseName: string): string {
  return [
    `Base "${baseName}" is set but hasn't been initialized yet.`,
    '',
    'Type /init to index this project, or run `kb init` from your terminal.',
  ].join('\n')
}
