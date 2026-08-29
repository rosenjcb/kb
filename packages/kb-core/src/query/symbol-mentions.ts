/**
 * Extract declared-symbol mentions from a natural-language query.
 *
 * The entity registry resolves scope from harvested entity names, but on a real
 * repo that harvest is thin and skewed: on `kestra` it holds 208 HTTP routes and
 * only 28 modules, so a question about the `Scheduler` class resolves the
 * manifest-derived CLI command `scheduler` instead — a different referent that
 * shares a word. Meanwhile the AST indexer has already written 20,761 rows to
 * `code_symbols`, every one carrying the declaring file's path.
 *
 * This module bridges that gap: it pulls identifier-shaped mentions out of the
 * question so retrieval can look them up by name and promote the files that
 * declare them.
 *
 * Matching here is deliberately generous because the consumer only ever
 * *promotes*. Narrowing on a wrong name discards the answer silently; ranking on
 * a wrong name costs a few positions. Those are not symmetric risks, so the
 * looser rule belongs on the ranking side.
 */

/**
 * Words that are identifier-shaped in prose but name nothing specific. A bare
 * `service` or `client` matches dozens of declarations and promotes noise.
 */
const GENERIC_MENTIONS = new Set([
  'about', 'action', 'actions', 'after', 'agent', 'answer', 'api', 'application',
  'available', 'base', 'before', 'build', 'builds', 'called', 'change', 'client',
  'code', 'command', 'component', 'components', 'config', 'content', 'context',
  'create', 'created', 'data', 'default', 'define', 'defined', 'differ',
  'different', 'display', 'document', 'documents', 'during', 'editor', 'error',
  'event', 'execute', 'feature', 'field', 'file', 'files', 'first', 'flow',
  'flows', 'format', 'function', 'given', 'graph', 'group', 'handle', 'handler',
  'index', 'indexing', 'input', 'inputs', 'install', 'interface', 'internal',
  'issue', 'kind', 'level', 'library', 'limit', 'link', 'list', 'local',
  'making', 'manager', 'method', 'model', 'module', 'name', 'named', 'normal',
  'object', 'option', 'options', 'output', 'outputs', 'package', 'parse',
  'parser', 'path', 'phase', 'phases', 'plugin', 'plugins', 'process',
  'project', 'provider', 'query', 'queries', 'reader', 'record', 'registry',
  'relate', 'render', 'repo', 'repository', 'request', 'response', 'result',
  'results', 'return', 'route', 'routes', 'runner', 'schema', 'scope', 'search',
  'select', 'server', 'service', 'session', 'setting', 'source', 'start',
  'state', 'status', 'store', 'string', 'style', 'table', 'target', 'task',
  'tasks', 'test', 'their', 'these', 'thing', 'those', 'token', 'tokens',
  'tool', 'tools', 'type', 'types', 'update', 'usage', 'used', 'user',
  'using', 'value', 'version', 'view', 'where', 'which', 'while', 'window',
  'without', 'worker', 'write', 'writer',
])

/** Upper bound on names handed to the index — keeps the lane's cost bounded. */
export const MAX_SYMBOL_MENTIONS = 12

/** Shortest bare lowercase word accepted as a possible declaration name. */
const MIN_LOOSE_MENTION_LENGTH = 6

/** `TreeSitterIndexer`, `handleImportSubmit` — an internal capital. */
function isCamelCase(token: string): boolean {
  return /^[A-Za-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(token)
}

/** `code_symbols`, `flow_store` — an internal underscore. */
function isSnakeCase(token: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)
}

export interface SymbolMention {
  /** The name to look up, as written in the question. */
  name: string
  /**
   * `strict` mentions are identifier-shaped (CamelCase, snake_case, or
   * backticked) and name a declaration on their face. `loose` mentions are bare
   * prose words that may or may not be a declaration — "the scheduler" — and
   * are only safe for promotion.
   */
  confidence: 'strict' | 'loose'
}

/**
 * Pull candidate declaration names out of a question.
 *
 * Ordered strict-first so a caller that truncates to `MAX_SYMBOL_MENTIONS`
 * keeps the names most likely to be real declarations.
 */
export function extractSymbolMentions(query: string): SymbolMention[] {
  if (!query.trim()) return []

  const strict = new Map<string, SymbolMention>()
  const loose = new Map<string, SymbolMention>()

  // Backticked spans are an explicit "this is code" signal from the asker.
  for (const m of query.matchAll(/`([^`]+)`/g)) {
    const inner = m[1]?.trim()
    if (!inner) continue
    // `FlowCreate.vue handleImportSubmit` — take each identifier piece.
    for (const piece of inner.split(/[\s.,()[\]{}:;]+/)) {
      const name = piece.replace(/\.[a-z]+$/, '')
      if (name.length > 1 && /^[A-Za-z_]/.test(name)) {
        strict.set(name, { name, confidence: 'strict' })
      }
    }
  }

  for (const raw of query.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue
    if (strict.has(raw)) continue
    if (isCamelCase(raw) || isSnakeCase(raw)) {
      strict.set(raw, { name: raw, confidence: 'strict' })
      continue
    }
    const lower = raw.toLowerCase()
    if (
      raw.length >= MIN_LOOSE_MENTION_LENGTH &&
      /^[A-Za-z]+$/.test(raw) &&
      !GENERIC_MENTIONS.has(lower)
    ) {
      loose.set(lower, { name: raw, confidence: 'loose' })
    }
  }

  return [...strict.values(), ...loose.values()].slice(0, MAX_SYMBOL_MENTIONS)
}
