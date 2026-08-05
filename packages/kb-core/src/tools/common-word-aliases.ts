/**
 * Ordinary English words that are also common identifiers.
 *
 * An alias like `Role` or `facts` is spelled the same as a word people use in
 * ordinary prose, so a lowercase occurrence carries no evidence that the writer
 * meant the entity. "The *role* of the tree-sitter indexer" is a question about
 * an indexer; matching it to a Prisma `Role` enum and pruning retrieval to the
 * database schema is a false landing, not a scope decision.
 *
 * The list is a property of English, not a judgement about the entities — it is
 * not a ranking, a weight, or a relevance ordering, and nothing reads it except
 * the distinctiveness test below. Membership means one thing: this spelling also
 * occurs as an ordinary word, so seeing it proves less than it appears to.
 *
 * Multi-token aliases are exempt — `payment service` is not a phrase anyone
 * writes by accident.
 */
const COMMON_WORD_ALIASES = new Set([
  'action', 'area', 'base', 'block', 'body', 'box', 'branch', 'build', 'call',
  'case', 'chain', 'change', 'channel', 'character', 'chart', 'check', 'child',
  'choice', 'class', 'client', 'code', 'color', 'column', 'command', 'comment',
  'company', 'content', 'context', 'control', 'copy', 'core', 'count', 'cover',
  'cycle', 'data', 'date', 'day', 'default', 'design', 'detail', 'device',
  'direction', 'display', 'document', 'domain', 'driver', 'edge', 'element',
  'engine', 'entry', 'error', 'event', 'example', 'fact', 'facts', 'feature',
  'feed', 'field', 'file', 'filter', 'flag', 'flow', 'folder', 'form', 'format',
  'frame', 'function', 'graph', 'group', 'guide', 'handle', 'header', 'health',
  'help', 'history', 'home', 'host', 'image', 'index', 'info', 'input',
  'instance', 'interface', 'issue', 'item', 'job', 'key', 'label', 'language',
  'layer', 'layout', 'level', 'library', 'license', 'limit', 'line', 'link',
  'list', 'load', 'location', 'lock', 'log', 'machine', 'manager', 'map',
  'mark', 'market', 'match', 'member', 'memory', 'menu', 'merge', 'message',
  'method', 'metric', 'mode', 'module', 'monitor', 'month', 'name', 'network',
  'node', 'note', 'notice', 'number', 'object', 'offer', 'office', 'operation',
  'option', 'order', 'output', 'owner', 'package', 'page', 'panel', 'parent',
  'part', 'partner', 'path', 'pattern', 'payment', 'period', 'person', 'phase',
  'phone', 'picture', 'place', 'plan', 'platform', 'player', 'point', 'policy',
  'pool', 'port', 'position', 'post', 'preview', 'price', 'print', 'priority',
  'process', 'product', 'profile', 'program', 'project', 'property', 'provider',
  'purchase', 'query', 'question', 'queue', 'range', 'rate', 'reason', 'record',
  'reference', 'region', 'relation', 'release', 'report', 'request', 'resource',
  'response', 'result', 'review', 'right', 'role', 'room', 'root', 'route',
  'row', 'rule', 'run', 'sample', 'scale', 'schedule', 'scope', 'score',
  'screen', 'script', 'search', 'section', 'security', 'segment', 'selection',
  'sequence', 'series', 'server', 'service', 'session', 'set', 'setting',
  'share', 'sheet', 'shell', 'side', 'signal', 'site', 'size', 'slot',
  'solution', 'sort', 'source', 'space', 'span', 'speed', 'split', 'stack',
  'stage', 'standard', 'start', 'state', 'statement', 'station', 'status',
  'step', 'stock', 'storage', 'store', 'stream', 'structure', 'style',
  'subject', 'summary', 'support', 'surface', 'switch', 'symbol', 'system',
  'table', 'tag', 'target', 'task', 'team', 'template', 'term', 'test', 'text',
  'thread', 'ticket', 'time', 'timer', 'title', 'token', 'tool', 'topic',
  'total', 'track', 'transfer', 'tree', 'trigger', 'type', 'unit', 'update',
  'usage', 'user', 'value', 'vendor', 'version', 'view', 'volume', 'warning',
  'watch', 'window', 'work', 'worker', 'year', 'zone',
])

/**
 * Does this alias match distinctively enough to steer retrieval on its own?
 *
 * A single-token alias that is also an ordinary English word needs its own
 * capitalization echoed back — writing `Role` mid-sentence is a deliberate
 * reference to an identifier, writing `role` is not. An all-lowercase alias
 * gets no such tell (prose is lowercase too), so it never qualifies: `facts`
 * in a sentence is indistinguishable from `facts` the table.
 *
 * A non-distinctive match is not discarded. It stops short-circuiting the
 * deterministic path, which is what sends the question to the LLM classifier —
 * a judge that can actually weigh whether the word was meant as a name.
 *
 * @param alias  the stored alias, in its own casing
 * @param surface  the text as it appears in the query
 */
export function isDistinctiveAliasMatch(alias: string, surface: string): boolean {
  const normalized = alias.trim().toLowerCase()
  if (normalized.includes(' ')) return true
  if (!COMMON_WORD_ALIASES.has(normalized)) return true
  // Lowercase spelling of a lowercase common word — nothing separates the two
  // readings, so the match proves nothing.
  if (alias === normalized) return false
  return alias === surface
}
