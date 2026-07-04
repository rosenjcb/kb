/** Shared TUI slash-command input contexts (used by init-cli prompts and TUI registry). */
export type SlashInputContext =
  | 'idle'
  | 'docs-generate-question'
  | 'docs-generate-review'
  | 'init-free-text'
  | 'init-question'
  | 'named-list-confirm'
  | 'scan-base-picker'
