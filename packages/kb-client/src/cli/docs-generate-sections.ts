import type { UserDefinedDocSection } from '@kb/core/core/doc-generate-session.js'
import type { SlashInputContext } from '../tui/slash-command-registry.js'
import { promptNamedListInterview, type NamedListInterviewIO } from './named-list-interview'

export interface DocSectionsIO {
  writeLine: (msg: string) => void
  readLine: (prompt: string, opts?: { slashContext?: SlashInputContext }) => Promise<string | null>
}

function toNamedListInterviewIO(io: DocSectionsIO): NamedListInterviewIO {
  return {
    write: message => io.writeLine(message),
    ask: async (prompt, opts) => {
      const answer = await io.readLine(prompt, opts)
      if (answer === null) return '/cancel'
      return answer
    },
  }
}

export async function promptUserDocSections(
  io: DocSectionsIO
): Promise<UserDefinedDocSection[] | 'skip' | 'cancel'> {
  const result = await promptNamedListInterview(
    toNamedListInterviewIO(io),
    {
      label: 'docs generate',
      itemNounSingular: 'section',
      itemNounPlural: 'sections',
      listLabel: 'Sections',
      defaultDescription: name => `Content about ${name.toLowerCase()}`,
      slashContext: {
        name: 'docs-generate-question',
        description: 'init-free-text',
        confirm: 'named-list-confirm',
      },
    },
    ({ name, description }) => ({ name, description })
  )

  if (result.kind === 'cancel') return 'cancel'
  if (result.kind === 'skip') return 'skip'
  return result.items
}
