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

/** Common extensionless filenames that are still real openable paths. */
const EXTENSIONLESS_BASENAMES = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'license',
  'licence',
  'copying',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'gemfile',
  'rakefile',
  'procfile',
  'vagrantfile',
  'brewfile',
  'justfile',
])

/**
 * True when `relPath` looks like something an agent can open in a workspace —
 * not a document-id slug (`src-core-init-md`), not synthetic integration
 * provenance (`integration:dep:vitest`).
 */
export function isOpenableSourcePath(relPath: string): boolean {
  const p = relPath.trim().replace(/^\.\//, '')
  if (!p) return false
  // Cross-repo integration facts use `…/integration:…` as provenance, not a file.
  if (/(^|\/)integration:/.test(p)) return false
  const base = p.split('/').pop() || ''
  if (!base || base === '.' || base === '..') return false
  // Dotfiles like `.env` / `.gitignore` are openable.
  if (base.startsWith('.') && base.length > 1 && !base.includes('..')) return true
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) {
    return EXTENSIONLESS_BASENAMES.has(base.toLowerCase())
  }
  const ext = base.slice(dot + 1)
  // Real extensions are short alphanumerics (`ts`, `md`, `tsx`). Slug tails that
  // survived a `/`→`-` pass never look like this once a true extension is gone.
  return /^[A-Za-z0-9]{1,10}$/.test(ext)
}

/**
 * Resolve a fact's `source_ref` to a physical file location an agent can open.
 * Two conventions are stored (see `scan-fact-ingest.ts` / `tree-sitter-indexer.ts`):
 *   - code: `ast:<relPath>@<symbol>` → `{ path: relPath, symbol }`
 *   - docs: `<relPath>#s<N>` (segment anchor) → `{ path: relPath }`
 * `gitRepo`, when present, is prefixed so multi-repo bases stay unambiguous
 * (`<repo>/<relPath>`). Returns `undefined` for empty, unrecognized, or
 * non-openable refs (synthetic `replace:<id>`, document-id slugs like
 * `src-core-init-md`, heritage `ast:edge:<sha>`) rather than surfacing a non-file.
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
    // Heritage/import hash refs (`ast:edge:<sha>`, `ast:import:<sha>`) encode no
    // openable path — they hash the file away. Surfacing them yields a bogus
    // `edge:<sha>` "filename", so treat them as non-file refs.
    if (body.startsWith('edge:') || body.startsWith('import:')) return undefined
    const at = body.lastIndexOf('@')
    relPath = at === -1 ? body : body.slice(0, at)
    symbol = at === -1 ? undefined : body.slice(at + 1) || undefined
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) {
    // Scheme-like at the start only (e.g. `replace:<id>`, `https://…`).
    // Colons in later path segments are fine (`skills/kb:dev-workflow/SKILL.md`).
    return undefined
  } else {
    // Doc segment anchor `<relPath>#s<N>` — drop the fragment.
    const hash = ref.indexOf('#')
    relPath = hash === -1 ? ref : ref.slice(0, hash)
  }

  relPath = relPath.trim().replace(/^\.\//, '')
  // Drop document-id slugs (`src-core-init-md`) and synthetic integration refs —
  // they are not workspace paths. Good scan ingest already stores `path#sN` for
  // the same markdown, so rejecting the slug just stops the broken citation.
  if (!relPath || !isOpenableSourcePath(relPath)) return undefined

  const repo = gitRepo?.trim()
  const path = repo && !relPath.startsWith(`${repo}/`) ? `${repo}/${relPath}` : relPath
  return symbol ? { path, symbol } : { path }
}
