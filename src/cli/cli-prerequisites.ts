/**
 * Single source of truth for user-facing prerequisite errors (KB base vs LLM).
 * Use these strings everywhere so CLI, TUI, and tests stay aligned.
 */

/** Shown when no effective KB base exists and no `--base` override applies. */
export const CLI_ERROR_NO_KB_BASE =
  'No knowledge base selected. Use `kb base use <base>` or `kb base use --default <base>`.'

/** Shown when an LLM provider cannot be constructed from config + environment. */
export const CLI_ERROR_NO_LLM_PROVIDER =
  'No LLM provider available. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in your environment, or run `kb config llm`.'

/** Non-interactive `kb init` without `--git` and without a saved default path. */
export const CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE = 'kb init requires at least one git remote. Pass \`kb init --git <url> [--base <name>]\`.'

export function formatPrerequisiteError(message: string): string {
  return `❌ ${message}`
}

export function uninitializedBaseNotice(baseName: string): string {
  return [
    `Base "${baseName}" is set but hasn't been initialized yet.`,
    '',
    'Type /init --git <url> to clone and index a repository, or run `kb init --git <url>` from your terminal.',
  ].join('\n')
}

export function initCancelledNotice(baseName?: string): string {
  const trimmedBase = baseName?.trim()
  const statusLine = trimmedBase
    ? `"${trimmedBase}" is not set up yet — nothing was saved.`
    : 'Your knowledge base is not set up yet — nothing was saved.'

  return [
    'No problem — init was cancelled.',
    '',
    statusLine,
    '',
    "Whenever you're ready:",
    '  • Type /init --git <url> here',
    '  • Or run `kb init --git <url>` from your terminal',
  ].join('\n')
}

export function scanCancelledNotice(baseName?: string): string {
  const trimmedBase = baseName?.trim()
  const statusLine = trimmedBase
    ? `Your "${trimmedBase}" knowledge base was left unchanged.`
    : 'Your knowledge base was left unchanged.'

  return [
    'No problem — scan was cancelled.',
    '',
    statusLine,
    '',
    'Run /scan again whenever you want to refresh this project.',
  ].join('\n')
}

/**
 * Shown when a .kb file points at an uninitialised base and we kick off init automatically.
 * We pass --base so the name-selection prompt is skipped.
 */
export function autoInitAnnouncement(baseName: string): string {
  return [
    `Base "${baseName}" was detected from a .kb file but hasn't been initialized yet.`,
    `Starting init for "${baseName}" — enter a git remote URL when prompted.`,
  ].join('\n')
}

/** True when the TUI should kick off init automatically on startup. */
export function shouldAutoInit(
  source: string,
  hasIndex: boolean,
): boolean {
  return !hasIndex && source === 'directory:.kb'
}
