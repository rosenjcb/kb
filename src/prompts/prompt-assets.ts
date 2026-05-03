import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute directory for runtime prompt assets (flat `*.md`, `doc-questionnaires/*.md`, etc.).
 *
 * - **tsx / tests:** `src/prompts/`
 * **Bundled CLI (`dist/bin/kb.js`):** `dist/bin/` — see `scripts/build-cli.mjs`, which copies
 * `src/prompts` markdown (flat and `doc-questionnaires`) next to the bundle so this path stays valid.
 *
 * Use {@link resolvePromptPath} / {@link readPromptAssetUtf8} from tools and orchestrators
 * instead of re-deriving paths from `import.meta.url` elsewhere.
 */
export const promptsRootDir = dirname(fileURLToPath(import.meta.url))

/** Join path segments under {@link promptsRootDir}. */
export function resolvePromptPath(...segments: string[]): string {
  return join(promptsRootDir, ...segments)
}

/** Read a UTF-8 file under the prompts root (no trim). */
export function readPromptAssetUtf8(...segments: string[]): string {
  return readFileSync(resolvePromptPath(...segments), 'utf8')
}
