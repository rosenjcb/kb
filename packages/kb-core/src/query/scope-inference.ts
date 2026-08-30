/**
 * Stage-0 scope inference (packages/kb-core/src/tools/ECOSYSTEM_HARVESTERS.spec.md §5): work out which
 * domain / service / api / surface a query is about BEFORE any fuzzy retrieval
 * runs, and turn the verdict into partition pruning under the multiclass
 * confidence gates.
 *
 * Two tiers, cheap-first:
 *  1. Deterministic mention resolution — longest-alias match over the registry.
 *  2. LLM scope classifier over the entity catalog (bounded, best-effort) when
 *     nothing matched deterministically.
 *
 * The additivity contract (§8a) is enforced structurally here:
 *  - No positive identification → no exclusions (verdict discarded wholesale).
 *  - Hard pruning requires BOTH a `very_confident` landing and a
 *    `certainly_incorrect` rule-out; anything softer excludes nothing.
 *  - Excluded fact ids come only from `entity_links` rows — unlinked facts
 *    (the entire un-harvested world) are never prunable.
 *  - Coverage cap: hard pruning also requires both ends of the pair to have
 *    linked facts, so an empty or half-built registry cannot hide anything.
 */

import type { LLMProvider } from '../core/types.js'
import { EntityRegistry, type EntityRow } from '../tools/entity-registry.js'

export type ScopeLabel =
  | 'very_confident'
  | 'confident'
  | 'unsure'
  | 'very_unsure'
  | 'certainly_incorrect'

export interface ScopeCandidate {
  entity: EntityRow
  label: ScopeLabel
}

export interface ScopeVerdict {
  /** True when no scope could be inferred — retrieval must run today's path unchanged. */
  unresolved: boolean
  candidates: ScopeCandidate[]
  /** Fact ids to hard-prune (linked facts of certainly_incorrect entities only). */
  excludedFactIds: string[]
  /**
   * Human-readable interpretation line, e.g. `Interpreting "internal" as the
   * internal service (payments-core); not the Internal Services surface.`
   * Disclosed in synthesis whenever resolution happened — silent disambiguation
   * is how trust dies.
   */
  disclosure?: string
  /** How the verdict was reached — for telemetry / --trace. */
  method: 'none' | 'alias' | 'llm'
  /**
   * Entity-guarded expansion terms (the landing entity's aliases). When present,
   * the pipeline appends these instead of running generic graph expansion — the
   * `LIKE '%name%'` widening is exactly what pulls colliding neighborhoods in.
   */
  expansionTerms?: string[]
  /**
   * Fact ids linked to confident landings. Retrieval includes these by set
   * membership rather than a weighted term (#238 promote, don't only prune).
   */
  promotedFactIds?: string[]
}

const UNRESOLVED: ScopeVerdict = {
  unresolved: true,
  candidates: [],
  excludedFactIds: [],
  method: 'none',
}

/** Max catalog size sent to the LLM classifier — beyond this, skip tier 2. */
const MAX_CLASSIFIER_CATALOG = 200

export async function inferQueryScope(input: {
  dbPath: string
  query: string
  llm?: LLMProvider
}): Promise<ScopeVerdict> {
  let registry: EntityRegistry
  try {
    registry = new EntityRegistry(input.dbPath, { readOnly: true })
  } catch {
    return UNRESOLVED
  }

  try {
    if (registry.entityCount() === 0) return UNRESOLVED

    // Only a distinctive match short-circuits the classifier. A bare common word
    // — "the *role* of the indexer" against a `Role` enum — used to land here
    // `very_confident` and hard-prune, and the classifier that could have caught
    // it never ran. Those now fall through to tier 2 instead of deciding.
    const mentions = registry.resolveMentions(input.query).filter(m => m.distinctive)
    if (mentions.length > 0) {
      return withLandingAids(
        registry,
        gateDeterministicMentions(
          registry,
          mentions.map(m => m.entity)
        )
      )
    }

    if (input.llm) {
      const llmVerdict = await classifyScopeWithLLM(registry, input.query, input.llm)
      if (llmVerdict) return withLandingAids(registry, llmVerdict)
    }

    return UNRESOLVED
  } catch {
    // Registry unreadable (e.g. pre-entity-schema database opened read-only):
    // scope inference is additive-only, so any storage error means today's path.
    return UNRESOLVED
  } finally {
    registry.close()
  }
}

/**
 * Deterministic gate. A unique alias hit lands `very_confident`; its
 * `distinct_from` siblings become `certainly_incorrect` and are hard-pruned —
 * but only when both ends of the pair have linked facts (coverage rule).
 * Multiple distinct entities matched (a collision the longest-match rule could
 * not separate) → all land `confident`: retrieval proceeds unpruned and the
 * ambiguity is disclosed.
 */
function gateDeterministicMentions(registry: EntityRegistry, matched: EntityRow[]): ScopeVerdict {
  const unique = dedupeById(matched)
  const repoOnly = unique.every(e => e.kind === 'repo')
  if (unique.length === 0 || repoOnly) return UNRESOLVED

  if (unique.length > 1) {
    const candidates: ScopeCandidate[] = unique.map(entity => ({ entity, label: 'confident' }))
    return {
      unresolved: false,
      candidates,
      excludedFactIds: [],
      disclosure: `The question mentions multiple known things: ${unique
        .map(describeEntity)
        .join('; ')}. Answering across all of them — say which one you meant to narrow down.`,
      method: 'alias',
    }
  }

  const landing = unique[0]
  if (!landing) return UNRESOLVED
  const candidates: ScopeCandidate[] = [{ entity: landing, label: 'very_confident' }]
  const excluded: string[] = []
  const ruledOutNames: string[] = []

  for (const collision of registry.distinctFromSiblings(landing.id)) {
    const sibling = collision.toEntity.id === landing.id ? collision.fromEntity : collision.toEntity
    candidates.push({ entity: sibling, label: 'certainly_incorrect' })
    // Coverage rule: hard-prune only when both the landing and the ruled-out
    // sibling actually partition facts. Only linked facts are ever excluded.
    if (registry.hasLinks(landing.id) && registry.hasLinks(sibling.id)) {
      excluded.push(...registry.linkedFactIds([sibling.id]))
      ruledOutNames.push(describeEntity(sibling))
    }
  }

  const disclosure =
    ruledOutNames.length > 0
      ? `Interpreting the question as being about ${describeEntity(landing)}; not ${ruledOutNames.join(' or ')}.`
      : `Interpreting the question as being about ${describeEntity(landing)}.`

  const expansionTerms = dedupeStrings(registry.listAliases(landing.id).map(alias => alias.alias))

  return {
    unresolved: false,
    candidates,
    excludedFactIds: dedupeStrings(excluded),
    disclosure,
    method: 'alias',
    ...(expansionTerms.length > 0 ? { expansionTerms } : {}),
  }
}

/**
 * Tier-2 LLM scope classifier: one bounded routing call over the entity catalog
 * (kinds + names + glosses — never the fact store). Emits verbal labels only;
 * numeric confidence from an LLM is noise. Best-effort: any parse or transport
 * error → unresolved, today's path.
 *
 * LLM verdicts are capped at `confident` — soft signal only, never hard pruning.
 * Hard pruning is reserved for deterministic alias resolution, where the match
 * is exact. This keeps a confidently-wrong classifier harmless by construction.
 */
async function classifyScopeWithLLM(
  registry: EntityRegistry,
  query: string,
  llm: LLMProvider
): Promise<ScopeVerdict | null> {
  const entities = registry.listEntities().filter(e => e.kind !== 'repo')
  if (entities.length === 0 || entities.length > MAX_CLASSIFIER_CATALOG) return null

  const catalog = entities
    .map(
      e => `- id=${e.id} kind=${e.kind} name="${e.canonicalName}"${e.gloss ? ` — ${e.gloss}` : ''}`
    )
    .join('\n')

  const prompt = [
    'You are a scope router for a knowledge base. Given a user question and a catalog of named things,',
    'label each catalog entry with exactly one of: very_confident, confident, unsure, very_unsure, certainly_incorrect.',
    '- very_confident / confident: the question is (probably) about this thing.',
    '- unsure / very_unsure: cannot tell / probably not, but cannot rule out.',
    '- certainly_incorrect: the question is provably not about this thing.',
    'When you cannot identify what the question is about, label everything unsure.',
    'Respond with ONLY a JSON array: [{"id": "...", "label": "..."}]. Omit entries labeled unsure.',
    '',
    `Question: ${query}`,
    '',
    'Catalog:',
    catalog,
  ].join('\n')

  try {
    const response = await llm.call({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800,
      temperature: 0,
    })
    const parsed = extractJsonArray(response.text)
    if (!parsed) return null

    const candidates: ScopeCandidate[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const { id, label } = item as { id?: unknown; label?: unknown }
      if (typeof id !== 'string' || !isScopeLabel(label)) continue
      const entity = registry.getEntityById(id)
      if (!entity) continue
      // Cap LLM positive labels at `confident` — no hard pruning from tier 2.
      const capped: ScopeLabel = label === 'very_confident' ? 'confident' : label
      candidates.push({ entity, label: capped })
    }

    const positives = candidates.filter(c => c.label === 'confident')
    // No positive identification → no verdict at all (additivity rule 1).
    if (positives.length === 0) return null

    return {
      unresolved: false,
      candidates,
      excludedFactIds: [],
      disclosure: `Interpreting the question as being about ${positives
        .map(c => describeEntity(c.entity))
        .join(' and ')}.`,
      method: 'llm',
    }
  } catch {
    return null
  }
}

/** Attach promoted fact ids and alias expansion terms to a resolved verdict. */
function withLandingAids(registry: EntityRegistry, verdict: ScopeVerdict): ScopeVerdict {
  if (verdict.unresolved) return verdict
  const positives = verdict.candidates.filter(
    c => c.label === 'very_confident' || c.label === 'confident'
  )
  if (positives.length === 0) return verdict
  const promotedFactIds = registry.linkedFactIds(positives.map(c => c.entity.id))
  const expansionTerms =
    verdict.expansionTerms && verdict.expansionTerms.length > 0
      ? verdict.expansionTerms
      : dedupeStrings(positives.flatMap(p => registry.listAliases(p.entity.id).map(a => a.alias)))
  return {
    ...verdict,
    ...(promotedFactIds.length > 0 ? { promotedFactIds } : {}),
    ...(expansionTerms.length > 0 ? { expansionTerms } : {}),
  }
}

function describeEntity(entity: EntityRow): string {
  return `the ${entity.canonicalName} ${entity.kind}${entity.gitRepo ? ` (${entity.gitRepo})` : ''}`
}

function isScopeLabel(value: unknown): value is ScopeLabel {
  return (
    value === 'very_confident' ||
    value === 'confident' ||
    value === 'unsure' ||
    value === 'very_unsure' ||
    value === 'certainly_incorrect'
  )
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

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
