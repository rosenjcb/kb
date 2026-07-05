/**
 * Single source of truth for user-facing prerequisite errors (KB base vs LLM).
 * Use these strings everywhere so CLI, TUI, and tests stay aligned.
 */

import {
  INDEXING_SERVER_MANAGED_NOTICE,
  uninitializedBaseNotice,
} from '@kb/core/config/indexing-notice.js'

export { INDEXING_SERVER_MANAGED_NOTICE, uninitializedBaseNotice }

/** Shown when no effective KB base exists and no `--base` override applies. */
export const CLI_ERROR_NO_KB_BASE =
  'No knowledge base selected. Use `kb base use <base>` or `kb base use --default <base>`.'

/** Shown when an LLM provider cannot be constructed from config + environment. */
export const CLI_ERROR_NO_LLM_PROVIDER =
  'No LLM provider available. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in your environment (or `KB_LLM_PROVIDER` to pick one).'

/** @deprecated Init is server-managed; retained for eval/internal callers only. */
export const CLI_ERROR_NO_KB_BASE_FOR_INIT_NON_INTERACTIVE =
  'Internal init requires git remotes via server KB_GIT_REPOS or programmatic runKbInit.'

export function formatPrerequisiteError(message: string): string {
  return `❌ ${message}`
}

export function initCancelledNotice(_baseName?: string): string {
  return INDEXING_SERVER_MANAGED_NOTICE
}

export function scanCancelledNotice(_baseName?: string): string {
  return INDEXING_SERVER_MANAGED_NOTICE
}

/** @deprecated Server bootstraps indexes; client no longer auto-inits. */
export function autoInitAnnouncement(_baseName: string): string {
  return INDEXING_SERVER_MANAGED_NOTICE
}

/** @deprecated */
export function shouldAutoInit(_source: string, _hasIndex: boolean): boolean {
  return false
}
