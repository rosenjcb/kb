/** Minimal slash-context shape for doc section prompts (no TUI dependency). */
export type DocSectionsSlashContext =
  | 'idle'
  | 'docs-generate-question'
  | 'named-list-confirm'
  | 'init-free-text'
  | 'init-question'

export interface DocSectionsIO {
  writeLine: (msg: string) => void
  readLine: (
    prompt: string,
    opts?: { slashContext?: DocSectionsSlashContext },
  ) => Promise<string | null>
}

export interface NamedListInterviewAskOptions {
  slashContext?: DocSectionsSlashContext
  suggestions?: string[]
}

export interface NamedListInterviewIO {
  write?: (message: string) => void
  ask: (prompt: string, opts?: NamedListInterviewAskOptions) => Promise<string>
}
