import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ManifestResult {
  passed: boolean
  declared: string[]
  actual: string[]
  undeclaredChanges: string[]
  phantomDeclarations: string[]
}

interface ManifestBlock {
  modified?: string[]
  created?: string[]
  deleted?: string[]
}

/** Extract the manifest block from an agent's final message text. */
export function extractManifest(agentMessage: string): string[] {
  const jsonBlockPattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g
  const inlinePattern = /\{[\s\S]*?"manifest"[\s\S]*?\}/g

  const candidates: string[] = []

  for (const match of agentMessage.matchAll(jsonBlockPattern)) {
    candidates.push(match[1])
  }
  if (candidates.length === 0) {
    for (const match of agentMessage.matchAll(inlinePattern)) {
      candidates.push(match[0])
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { manifest?: ManifestBlock }
      if (parsed.manifest && typeof parsed.manifest === 'object') {
        const block = parsed.manifest
        const files: string[] = [
          ...(Array.isArray(block.modified) ? block.modified : []),
          ...(Array.isArray(block.created) ? block.created : []),
          ...(Array.isArray(block.deleted) ? block.deleted : []),
        ]
        return files.map(f => String(f).trim()).filter(Boolean)
      }
    } catch {
      // try next candidate
    }
  }

  return []
}

export class ManifestValidator {
  /**
   * Validate that the declared manifest matches actual git changes.
   *
   * Passes only if `undeclaredChanges` is empty.
   * Phantom declarations (files declared but not actually changed) are a warning, not a failure.
   */
  async validate(manifest: string[], repoPath: string): Promise<ManifestResult> {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    })

    const actual = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    const declaredSet = new Set(manifest)
    const actualSet = new Set(actual)

    const undeclaredChanges = actual.filter(f => !declaredSet.has(f))
    const phantomDeclarations = manifest.filter(f => !actualSet.has(f))

    return {
      passed: undeclaredChanges.length === 0,
      declared: manifest,
      actual,
      undeclaredChanges,
      phantomDeclarations,
    }
  }
}
