import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const loaderDir = dirname(fileURLToPath(import.meta.url))

export function loadSkill(name: string): string {
  // Prod: build copies skills/<name>/SKILL.md → dist/bin/<name>.skill.md
  try {
    return readFileSync(join(loaderDir, `${name}.skill.md`), 'utf8').trim()
  } catch {
    // Dev (tsx): packages/kb-core/src/skills → repo root is four levels up
    return readFileSync(join(loaderDir, '..', '..', '..', '..', 'skills', name, 'SKILL.md'), 'utf8').trim()
  }
}
