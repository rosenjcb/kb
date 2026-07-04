import type {
  DocSectionsSlashContext,
  NamedListInterviewAskOptions,
  NamedListInterviewIO,
} from '@kb/core/cli/doc-sections-types.js'

export type { NamedListInterviewAskOptions, NamedListInterviewIO }

export interface NamedListInterviewOptions {
  label: string
  itemNounSingular: string
  itemNounPlural: string
  listLabel: string
  defaultDescription: (name: string) => string
  slashContext?: {
    name?: DocSectionsSlashContext
    description?: DocSectionsSlashContext
    confirm?: DocSectionsSlashContext
  }
}

export type NamedListInterviewOutcome<T> =
  | { kind: 'skip' }
  | { kind: 'cancel' }
  | { kind: 'accepted'; items: T[] }

function formatNamePrompt(
  label: string,
  itemNounSingular: string,
  itemCount: number
): string {
  if (itemCount === 0) {
    return `\n[${label}] Enter ${itemNounSingular} name (blank or /skip to skip, /cancel): `
  }
  return `\n[${label}] Enter another ${itemNounSingular} name (/complete to finish, /cancel): `
}

function writeCollectedList(
  io: NamedListInterviewIO,
  listLabel: string,
  names: string[]
): void {
  if (names.length === 0) return
  io.write?.(
    `\n${listLabel} so far:\n${names.map((name, index) => `  ${index + 1}. ${name}`).join('\n')}\n\n`
  )
}

function writeReviewList(
  io: NamedListInterviewIO,
  listLabel: string,
  entries: Array<{ name: string; description: string }>
): void {
  io.write?.(
    `\n${listLabel}:\n${entries
      .map((entry, index) => `  ${index + 1}. ${entry.name} — ${entry.description}`)
      .join('\n')}\n\n`
  )
}

export async function promptNamedListInterview<T>(
  io: NamedListInterviewIO,
  options: NamedListInterviewOptions,
  buildItem: (input: { name: string; description: string }) => T
): Promise<NamedListInterviewOutcome<T>> {
  const { label, itemNounSingular, listLabel, defaultDescription, slashContext = {} } = options
  const nameContext = slashContext.name ?? 'init-question'
  const descriptionContext = slashContext.description ?? 'init-free-text'
  const confirmContext = slashContext.confirm ?? 'named-list-confirm'

  for (;;) {
    const items: T[] = []
    const entries: Array<{ name: string; description: string }> = []

    for (;;) {
      const raw = (await io.ask(formatNamePrompt(label, itemNounSingular, entries.length), {
        slashContext: nameContext,
      })).trim()

      if (raw === '/cancel') return { kind: 'cancel' }
      if (raw === '/complete') {
        if (entries.length === 0) return { kind: 'skip' }
        break
      }
      if (!raw || raw === '/skip') {
        if (entries.length === 0) return { kind: 'skip' }
        continue
      }

      const name = raw
      const placeholder = defaultDescription(name)
      const desc = (
        await io.ask(`> Description for "${name}" (blank: "${placeholder}"): `, {
          slashContext: descriptionContext,
        })
      ).trim()
      if (desc === '/cancel') return { kind: 'cancel' }

      const description = desc || placeholder
      entries.push({ name, description })
      items.push(buildItem({ name, description }))
      writeCollectedList(
        io,
        listLabel,
        entries.map(entry => entry.name)
      )
    }

    writeReviewList(io, listLabel, entries)

    const answer = (await io.ask('> /accept, /reject, or /cancel: ', { slashContext: confirmContext }))
      .trim()
      .toLowerCase()
    if (answer === '/cancel') return { kind: 'cancel' }
    if (answer === '/accept') return { kind: 'accepted', items }
  }
}
