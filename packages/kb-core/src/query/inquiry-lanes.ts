/**
 * Ontology-typed inquiry lanes — turning a resolved entity into targeted
 * sub-queries instead of guessing facets from the question string.
 *
 * ## Why not the 5 Ws
 *
 * Professional investigators do not fan a question out across who/what/where.
 * Three practices shaped this module:
 *
 *  - **Intelligence requirements decomposition** (US Army ATP 2-01): a broad
 *    requirement is never collected against directly. It is broken into
 *    *indicators* — observable things that would be true if a given answer were
 *    correct — and then into specific, answerable collection questions. Here the
 *    indicators come from the entity graph: if the question is about a service,
 *    the things that would be indexed about it are its endpoints, its owner, its
 *    dependencies. We retrieve on those, not on the user's phrasing.
 *
 *  - **Analysis of Competing Hypotheses** (Heuer): evidence consistent with every
 *    candidate answer has zero diagnostic value. So lanes are built per resolved
 *    entity and qualified to separate it from its `distinct_from` siblings,
 *    rather than emitting generic facets any candidate would satisfy.
 *
 *  - **Kepner-Tregoe IS/IS-NOT**: the boundary of a thing carries information.
 *    Note the direction this takes below — the IS-NOT half becomes a *qualifier*
 *    that sharpens a lane, never a lane of its own. Retrieving a ruled-out
 *    sibling's facts is exactly what `scope-inference.ts` exists to prevent.
 *
 * Lanes are deterministic: no LLM call. The generic LLM expander
 * (`tools/query-expander.ts`) stays as the fallback for questions where no entity
 * resolves at all.
 */

import {
  EntityRegistry,
  type EntityKind,
  type EntityRow,
} from '../tools/entity-registry.js'
import { isEntityScopeEnabled, type ScopeVerdict } from './scope-inference.js'

/** What an individual lane is trying to establish about the entity. */
export type InquiryFacet =
  /** What the thing is — canonical name plus its gloss vocabulary. */
  | 'identity'
  /** How it works — kind-conditioned, the only facet that uses a template. */
  | 'mechanism'
  /** Who owns / is accountable for it. */
  | 'ownership'
  /** Where it sits — the domain / repo / surface it belongs to. */
  | 'locus'
  /** What it relies on, or what relies on it. */
  | 'dependency'
  /** What it is made of — its constituent parts. */
  | 'composition'

export interface InquiryLane {
  facet: InquiryFacet
  /** Keyword cluster handed to retrieval — a noun phrase, not a question. */
  query: string
  /** Entity this lane was derived from. */
  entityId: string
}

/** Matches the fan-out width the LLM expander already used. */
const MAX_LANES = 4
/** Landing entities to build lanes for — beyond this the fan-out stops being targeted. */
const MAX_ENTITIES = 2
/** Neighbors folded into a single edge lane. */
const MAX_NEIGHBORS_PER_LANE = 3

/**
 * Kind-conditioned mechanism probes. This is the ontology doing work the
 * question string cannot: a `model` and a `cli` are vague in different ways, so
 * "tell me about X" should retrieve different things for each.
 */
const KIND_MECHANISM_FACETS: Record<EntityKind, string[]> = {
  service: ['endpoints routes request handling', 'deployment runtime configuration'],
  api: ['endpoints request response shape', 'authentication errors status codes'],
  model: ['schema fields columns types', 'relations foreign keys constraints'],
  cli: ['commands subcommands usage', 'flags options configuration'],
  library: ['exported api surface', 'installation usage integration'],
  module: ['exports responsibilities', 'callers and dependents'],
  surface: ['screens routes navigation', 'data sources backing it'],
  domain: ['scope and boundaries', 'services and teams within it'],
  team: ['ownership responsibilities', 'services and repos owned'],
  repo: ['packages and layout', 'build tooling and scripts'],
}

const GENERIC_MECHANISM_FACETS = ['purpose and responsibilities', 'design and behavior']

export interface BuildInquiryLanesInput {
  dbPath: string
  /** The user's question, pre-expansion. */
  query: string
  /**
   * Stage-0 verdict, when the caller already ran it. Reusing it avoids a second
   * pass over the registry and keeps lane targets consistent with the scope
   * disclosure the user is shown.
   */
  verdict?: ScopeVerdict
  maxLanes?: number
}

/**
 * Build typed sub-query lanes for a question. Returns `[]` whenever no entity
 * resolves, the registry is empty/unreadable, or the kill switch is set — the
 * caller then runs its existing expansion path unchanged.
 */
export function buildInquiryLanes(input: BuildInquiryLanesInput): InquiryLane[] {
  // Lanes are entity-scope machinery, so they follow the registry's existing
  // switch — disabling the registry's influence on retrieval disables this too.
  if (!isEntityScopeEnabled()) return []
  const query = input.query.trim()
  if (!query) return []

  let registry: EntityRegistry
  try {
    registry = new EntityRegistry(input.dbPath, { readOnly: true })
  } catch {
    return []
  }

  try {
    const landings = resolveLandings(registry, query, input.verdict)
    if (landings.length === 0) return []

    const lanes: InquiryLane[] = []
    for (const entity of landings) {
      lanes.push(...lanesForEntity(registry, entity, query))
    }
    return dedupeLanes(lanes).slice(0, input.maxLanes ?? MAX_LANES)
  } catch {
    // Lanes are strictly additive; any storage error means the caller's old path.
    return []
  } finally {
    registry.close()
  }
}

/**
 * Which entities to build lanes for. A supplied verdict is authoritative in both
 * directions: its positives become the lane targets, and an *unresolved* verdict
 * means stage-0 declined to interpret the question, so lanes decline too rather
 * than re-deriving an interpretation stage-0 already passed on. Callers that
 * never ran stage-0 omit the verdict and get deterministic mention resolution.
 *
 * `repo` entities are never landings, for the same reason scope inference skips
 * them: a repo match says almost nothing about what the question is about.
 */
function resolveLandings(
  registry: EntityRegistry,
  query: string,
  verdict?: ScopeVerdict
): EntityRow[] {
  if (verdict) {
    if (verdict.unresolved) return []
    const positives = verdict.candidates
      .filter(c => c.label === 'very_confident' || c.label === 'confident')
      .map(c => c.entity)
      .filter(e => e.kind !== 'repo')
    return dedupeById(positives).slice(0, MAX_ENTITIES)
  }

  const mentioned = registry
    .resolveMentions(query)
    .map(m => m.entity)
    .filter(e => e.kind !== 'repo')
  return dedupeById(mentioned).slice(0, MAX_ENTITIES)
}

/**
 * Lanes for one entity, ontology-grounded first. Edge lanes come from real
 * relationships, so they carry names retrieval can actually hit; mechanism lanes
 * are templated and only fill remaining width.
 */
function lanesForEntity(
  registry: EntityRegistry,
  entity: EntityRow,
  query: string
): InquiryLane[] {
  const qualifier = contrastQualifier(registry, entity)
  const name = entity.canonicalName
  const out: InquiryLane[] = []

  const push = (facet: InquiryFacet, parts: string[]) => {
    const text = qualify([name, ...parts].join(' '), qualifier)
    out.push({ facet, query: text, entityId: entity.id })
  }

  const edges = registry.listEdges(entity.id)
  const owners = neighborNames(edges, e => e.edgeType === 'owned_by' && e.direction === 'out')
  const parents = neighborNames(
    edges,
    e => (e.edgeType === 'belongs_to' || e.edgeType === 'part_of') && e.direction === 'out'
  )
  const dependsOn = neighborNames(edges, e => e.edgeType === 'depends_on' && e.direction === 'out')
  const dependents = neighborNames(edges, e => e.edgeType === 'depends_on' && e.direction === 'in')
  const children = neighborNames(
    edges,
    e => (e.edgeType === 'belongs_to' || e.edgeType === 'part_of') && e.direction === 'in'
  )

  if (owners.length > 0) push('ownership', [...owners, 'ownership responsibility'])
  if (parents.length > 0) push('locus', [...parents, 'belongs to part of'])
  if (dependsOn.length > 0) push('dependency', [...dependsOn, 'depends on integration'])
  else if (dependents.length > 0) push('dependency', [...dependents, 'depends on this consumer'])
  if (children.length > 0) push('composition', [...children, 'components parts'])

  for (const facet of mechanismFacets(entity.kind)) {
    push('mechanism', [facet])
  }

  // Identity last: the caller already fans out the raw question, which carries
  // the entity name. This lane only earns its slot by adding gloss vocabulary.
  const glossTerms = glossKeywords(entity.gloss, query)
  if (glossTerms.length > 0) push('identity', glossTerms)

  return out
}

/**
 * Kepner-Tregoe IS-NOT, applied as a qualifier rather than a lane. When the
 * entity has `distinct_from` siblings, its own repo (or failing that, its kind)
 * is appended so retrieval has something to separate the neighborhoods on.
 * Retrieving the *sibling's* facts would undo scope pruning, so we never do it.
 */
function contrastQualifier(registry: EntityRegistry, entity: EntityRow): string | undefined {
  const siblings = registry.distinctFromSiblings(entity.id)
  if (siblings.length === 0) return undefined
  return entity.gitRepo ?? entity.kind
}

function qualify(text: string, qualifier?: string): string {
  if (!qualifier) return text
  return text.toLowerCase().includes(qualifier.toLowerCase()) ? text : `${text} ${qualifier}`
}

function mechanismFacets(kind: EntityKind): string[] {
  return KIND_MECHANISM_FACETS[kind] ?? GENERIC_MECHANISM_FACETS
}

function neighborNames(
  edges: ReturnType<EntityRegistry['listEdges']>,
  predicate: (edge: ReturnType<EntityRegistry['listEdges']>[number]) => boolean
): string[] {
  const names = edges.filter(predicate).map(e => e.other.canonicalName)
  return [...new Set(names)].slice(0, MAX_NEIGHBORS_PER_LANE)
}

/**
 * Gloss words worth retrieving on: the domain vocabulary an entity's gloss adds
 * that the question does not already contain. Short/common words are dropped —
 * they widen retrieval without targeting it.
 */
function glossKeywords(gloss: string | undefined, query: string): string[] {
  if (!gloss) return []
  const inQuery = new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of gloss.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/)) {
    const token = raw.toLowerCase()
    if (token.length <= 3 || GLOSS_STOP_WORDS.has(token)) continue
    if (inQuery.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= 5) break
  }
  return out
}

const GLOSS_STOP_WORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'they',
  'them',
  'their',
  'these',
  'those',
  'which',
  'what',
  'when',
  'where',
  'into',
  'over',
  'under',
  'been',
  'were',
  'have',
  'does',
  'used',
  'uses',
  'using',
  'also',
  'each',
  'other',
  'same',
  'different',
  'thing',
  'things',
  'note',
  'conflate',
])

function dedupeLanes(lanes: InquiryLane[]): InquiryLane[] {
  const seen = new Set<string>()
  const out: InquiryLane[] = []
  for (const lane of lanes) {
    const key = lane.query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(lane)
  }
  return out
}

function dedupeById(entities: EntityRow[]): EntityRow[] {
  const seen = new Set<string>()
  const out: EntityRow[] = []
  for (const entity of entities) {
    if (seen.has(entity.id)) continue
    seen.add(entity.id)
    out.push(entity)
  }
  return out
}
