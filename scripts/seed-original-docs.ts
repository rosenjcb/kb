/**
 * One-off: insert repo source files into the dogfood KB as is_original = 1 documents.
 * Run with: npx tsx scripts/seed-original-docs.ts
 *
 * README.md is intentionally excluded — it is the site homepage (docs/index.md), not a doc entry.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteDocumentWriter } from '../src/tools/sqlite-document-writer'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// README.md intentionally omitted — it is the homepage, not a sidebar doc.
const SOURCE_FILES: Array<{ relPath: string; title: string }> = [
  { relPath: 'CLAUDE.md', title: 'Claude Instructions' },
  { relPath: 'AGENTS.md', title: 'Agents' },
  { relPath: 'TESTING.md', title: 'Testing' },
  { relPath: 'DESIGN.md', title: 'Design' },
  { relPath: 'EVALUATION.md', title: 'Evaluation' },
  { relPath: 'src/core/TUI.md', title: 'TUI' },
  { relPath: 'src/core/ORCHESTRATOR.md', title: 'Orchestrator' },
  { relPath: 'src/core/AGENT_LOOP.md', title: 'Agent Loop' },
]

const DOGFOOD_DB = path.join(
  process.env.HOME ?? '',
  '.kb',
  'sessions',
  'dogfood'
)

async function main() {
  const writer = new SqliteDocumentWriter({ baseDir: DOGFOOD_DB, base: 'dogfood' })

  for (const { relPath, title } of SOURCE_FILES) {
    const fullPath = path.join(ROOT, relPath)
    let content: string
    try {
      content = await readFile(fullPath, 'utf8')
    } catch {
      console.log(`  skip (not found): ${relPath}`)
      continue
    }

    const documentId = relPath
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)

    await writer.writeDocument({
      title,
      content,
      documentId,
      tags: ['source-excerpt'],
      isOriginal: true,
      overwrite: true,
    })

    console.log(`  ✓ ${relPath} → ${title} (${documentId})`)
  }

  console.log('\nDone. Run `kb publish jekyll --apply` to sync.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
