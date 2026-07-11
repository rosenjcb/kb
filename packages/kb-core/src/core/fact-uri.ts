/** Stored fact row ids use prefix `fact-` + hex; canonical URI is `fact://` + hex (no doubled "fact"). */
export function formatFactUri(id: string): string {
  if (id.startsWith('fact-')) {
    return `fact://${id.slice('fact-'.length)}`
  }
  return id
}

/** A fact's physical provenance: the source file it was extracted from, and (for code) the symbol. */
export interface FactSourceLocation {
  /** Repo-relative (or `<repo>/<relPath>`) path to the file the fact came from. */
  path: string
  /** For code facts, the exported symbol the fact describes (`ast:<relPath>@<symbol>`). */
  symbol?: string
}

/**
 * Resolve a fact's `source_ref` to a physical file location an agent can open.
 * Two conventions are stored (see `scan-fact-ingest.ts` / `tree-sitter-indexer.ts`):
 *   - code: `ast:<relPath>@<symbol>` → `{ path: relPath, symbol }`
 *   - docs: `<relPath>#s<N>` (segment anchor) → `{ path: relPath }`
 * `gitRepo`, when present, is prefixed so multi-repo bases stay unambiguous
 * (`<repo>/<relPath>`). Returns `undefined` for empty or unrecognized refs
 * (e.g. synthetic `replace:<id>` refs) rather than surfacing a non-file.
 */
export function sourceRefToPath(
  sourceRef: string | null | undefined,
  gitRepo?: string | null
): FactSourceLocation | undefined {
  const ref = sourceRef?.trim()
  if (!ref) return undefined

  let relPath: string
  let symbol: string | undefined

  if (ref.startsWith('ast:')) {
    const body = ref.slice('ast:'.length)
    const at = body.lastIndexOf('@')
    relPath = at === -1 ? body : body.slice(0, at)
    symbol = at === -1 ? undefined : body.slice(at + 1) || undefined
  } else if (ref.includes('://') || ref.includes(':')) {
    // Synthetic/opaque refs (e.g. `replace:<id>`) or URIs are not physical files.
    return undefined
  } else {
    // Doc segment anchor `<relPath>#s<N>` — drop the fragment.
    const hash = ref.indexOf('#')
    relPath = hash === -1 ? ref : ref.slice(0, hash)
  }

  relPath = relPath.trim().replace(/^\.\//, '')
  if (!relPath) return undefined

  const repo = gitRepo?.trim()
  const path = repo && !relPath.startsWith(`${repo}/`) ? `${repo}/${relPath}` : relPath
  return symbol ? { path, symbol } : { path }
}
