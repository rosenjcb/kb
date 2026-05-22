import type { UserDefinedDocSection } from '../core/doc-generate-session'

export interface DocSectionsIO {
  writeLine: (msg: string) => void
  readLine: (prompt: string) => Promise<string | null>
}

export async function promptUserDocSections(
  io: DocSectionsIO
): Promise<UserDefinedDocSection[] | 'skip' | 'cancel'> {
  for (;;) {
    const raw = await io.readLine(
      '\n[docs generate] Enter sections (comma-separated, /skip, or /cancel): '
    )
    if (raw === null || raw.trim() === '/cancel') return 'cancel'
    const trimmed = raw.trim()
    if (!trimmed || trimmed === '/skip') return 'skip'

    const names = trimmed.split(',').map(s => s.trim()).filter(Boolean)
    if (names.length === 0) return 'skip'

    io.writeLine(`\nSections:\n${names.map((name, i) => `  ${i + 1}. ${name}`).join('\n')}\n`)

    const answer = await io.readLine('> /accept or /reject: ')
    if (answer === null || answer.trim() === '/cancel') return 'cancel'
    if (answer.trim().toLowerCase() !== '/accept') continue

    const sections: UserDefinedDocSection[] = []
    for (const name of names) {
      const defaultDesc = `Content about ${name.toLowerCase()}`
      const desc = await io.readLine(`> Description for "${name}" (blank: "${defaultDesc}"): `)
      if (desc === null || desc.trim() === '/cancel') return 'cancel'
      sections.push({ name, description: desc.trim() || defaultDesc })
    }
    return sections
  }
}
