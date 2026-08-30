/**
 * Organizational Ontology Index — entity registry store.
 *
 * Canonical named things (services, surfaces, domains, repos, models, …) with aliases,
 * typed edges, and fact↔entity links, per packages/kb-core/src/tools/ECOSYSTEM_HARVESTERS.spec.md §3.
 *
 * The registry partitions the fact pool via `entity_links` so query-time scope
 * inference (`src/query/scope-inference.ts`) can land in the right partition
 * and rule out provably-wrong ones.
 *
 * Alias matching is exact/longest-match over normalized text — never fuzzy —
 * because entity resolution must be higher-precision than the fuzzy retrieval
 * channels it disambiguates. Normalization splits CamelCase and separators so
 * `TreeSitterIndexer` and `tree-sitter indexer` share one key. Exactness is not
 * sufficient on its own: an alias spelled like an ordinary English word matches
 * ordinary prose exactly, so each match also carries `distinctive` (see
 * `common-word-aliases.ts`), and callers that prune or steer retrieval require it.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../core/db-migrations.js'
import { isDistinctiveAliasMatch } from './common-word-aliases.js'

export type EntityKind =
  | 'domain'
  | 'team'
  | 'service'
  | 'surface'
  | 'repo'
  | 'module'
  | 'api'
  | 'library'
  | 'cli'
  /** ORM model / table / schema atom (not a deployable service). */
  | 'model'

/**
 * Where a harvested name came from — a fact about the extraction path, not a
 * judgment about the name.
 *
 * - `manifest`: parsed out of a file whose job is to declare identity, taking the
 *   identity it declares — `package.json` `name`, `fly.toml` `app`, a Backstage
 *   catalog entry, a `.proto` `service`, an OpenAPI `info.title`. A person wrote
 *   that string in order to name the thing.
 * - `source-pattern`: found by running a YAML `source_pattern` through the pattern
 *   engine over ordinary source — route decorators, `CREATE TABLE`, class
 *   declarations, Next.js file paths. The name is real but incidental; nobody
 *   declared it as an entity of the organization.
 *
 * The boundary is the emitting module: `ecosystem-harvesters.ts` emits `manifest`,
 * `pattern-engine.ts` emits `source-pattern` (asserted by TC-35).
 *
 * `manual` is the third value, reserved for curated rows, which re-harvest never
 * overwrites.
 */
export type EntitySourceKind = 'manifest' | 'source-pattern'

export type EntityEdgeType = 'belongs_to' | 'owned_by' | 'part_of' | 'depends_on' | 'distinct_from'

export interface EntityRow {
  id: string
  kind: EntityKind
  canonicalName: string
  gloss?: string
  gitRepo?: string
  sourceKind: string
}

export interface EntityAliasRow {
  entityId: string
  alias: string
  normalized: string
  source: string
}

export interface EntityEdgeRow {
  edgeType: EntityEdgeType
  /** Relative to the queried entity: `out` = it is the edge's `from` side. */
  direction: 'out' | 'in'
  other: EntityRow
  gloss?: string
}

export interface EntityCollision {
  fromEntity: EntityRow
  toEntity: EntityRow
  gloss?: string
}

export interface MentionMatch {
  entity: EntityRow
  alias: string
  start: number
  end: number
  /**
   * Whether this match is strong enough to steer retrieval by itself. False for
   * a single-token alias that is an ordinary English word occurring in ordinary
   * casing — see `isDistinctiveAliasMatch`. Callers that prune scope or aim a
   * sub-query should require it; callers merely listing what was mentioned
   * need not.
   */
  distinctive: boolean
}

/**
 * Lowercase, split CamelCase / snake / kebab into tokens, collapse whitespace —
 * the alias match key. `TreeSitterIndexer`, `tree-sitter indexer`, and
 * `tree_sitter_indexer` must share one key so prose can land on a CamelCase
 * harvest name (without this, "tree-sitter indexer" never matched the entity).
 */
export function normalizeEntityName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

export class EntityRegistry {
  private readonly db: DatabaseSync
  private readonly owned: boolean

  constructor(dbPathOrHandle: string | DatabaseSync, opts?: { readOnly?: boolean }) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new DatabaseSync(dbPathOrHandle, { readOnly: opts?.readOnly === true })
      this.owned = true
    } else {
      this.db = dbPathOrHandle
      this.owned = false
    }
    if (!opts?.readOnly) runMigrations(this.db)
  }

  close(): void {
    if (this.owned) this.db.close()
  }

  /**
   * Insert or update an entity by (kind, canonical_name). Manual rows
   * (`source_kind='manual'`) are never overwritten by automated re-harvests.
   */
  upsertEntity(input: {
    kind: EntityKind
    canonicalName: string
    gloss?: string
    gitRepo?: string
    sourceKind: string
    contentHash?: string
  }): string {
    const name = input.canonicalName.trim()
    const id = `ent-${sha256(`${input.kind}:${normalizeEntityName(name)}`).slice(0, 16)}`
    const existing = this.db
      .prepare('SELECT id, source_kind FROM entities WHERE id = ? AND tombstoned_at IS NULL')
      .get(id) as { id: string; source_kind: string } | undefined
    const now = nowIso()
    if (existing) {
      if (existing.source_kind === 'manual' && input.sourceKind !== 'manual') return id
      this.db
        .prepare(
          `UPDATE entities SET gloss = COALESCE(?, gloss), git_repo = COALESCE(?, git_repo),
             source_kind = ?, content_hash = COALESCE(?, content_hash),
             updated_at = ? WHERE id = ?`
        )
        .run(
          input.gloss ?? null,
          input.gitRepo ?? null,
          input.sourceKind,
          input.contentHash ?? null,
          now,
          id
        )
      return id
    }
    this.db
      .prepare(
        `INSERT INTO entities (id, kind, canonical_name, gloss, git_repo, source_kind, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        name,
        input.gloss ?? null,
        input.gitRepo ?? null,
        input.sourceKind,
        input.contentHash ?? null,
        now,
        now
      )
    // The canonical name is always its own alias.
    this.addAlias(id, name, input.sourceKind)
    return id
  }

  addAlias(entityId: string, alias: string, source: string): void {
    const normalized = normalizeEntityName(alias)
    if (!normalized) return
    this.db
      .prepare(
        `INSERT INTO entity_aliases (entity_id, alias, normalized, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (entity_id, normalized) DO NOTHING`
      )
      .run(entityId, alias.trim(), normalized, source)
  }

  addEdge(
    fromEntityId: string,
    toEntityId: string,
    edgeType: EntityEdgeType,
    gloss?: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO entity_edges (from_entity_id, to_entity_id, edge_type, gloss, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (from_entity_id, to_entity_id, edge_type) DO UPDATE SET
           gloss = COALESCE(excluded.gloss, gloss)`
      )
      .run(fromEntityId, toEntityId, edgeType, gloss ?? null, nowIso())
  }

  linkFact(factId: string, entityId: string, role: 'subject' | 'object' | 'mention'): void {
    this.db
      .prepare(
        `INSERT INTO entity_links (fact_id, entity_id, role) VALUES (?, ?, ?)
         ON CONFLICT (fact_id, entity_id, role) DO NOTHING`
      )
      .run(factId, entityId, role)
  }

  getEntityById(id: string): EntityRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, kind, canonical_name, gloss, git_repo, source_kind
         FROM entities WHERE id = ? AND tombstoned_at IS NULL`
      )
      .get(id) as
      | {
          id: string
          kind: string
          canonical_name: string
          gloss: string | null
          git_repo: string | null
      source_kind: string
        }
      | undefined
    return row ? toEntityRow(row) : undefined
  }

  /** Look an entity up by canonical name or any alias (normalized match). */
  findEntityByName(name: string): EntityRow[] {
    const normalized = normalizeEntityName(name)
    // Compact form covers indexes written before CamelCase splitting landed
    // (`treesitterindexer` vs `tree sitter indexer`).
    const compact = normalized.replace(/\s+/g, '')
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.id, e.kind, e.canonical_name, e.gloss, e.git_repo, e.source_kind
         FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         WHERE e.tombstoned_at IS NULL
           AND (a.normalized = ? OR replace(a.normalized, ' ', '') = ?)`
      )
      .all(normalized, compact) as Array<{
      id: string
      kind: string
      canonical_name: string
      gloss: string | null
      git_repo: string | null
      source_kind: string
    }>
    return rows.map(toEntityRow)
  }

  listEntities(kind?: EntityKind): EntityRow[] {
    const rows = (
      kind
        ? this.db
            .prepare(
              `SELECT id, kind, canonical_name, gloss, git_repo, source_kind
               FROM entities WHERE kind = ? AND tombstoned_at IS NULL ORDER BY canonical_name`
            )
            .all(kind)
        : this.db
            .prepare(
              `SELECT id, kind, canonical_name, gloss, git_repo, source_kind
               FROM entities WHERE tombstoned_at IS NULL ORDER BY kind, canonical_name`
            )
            .all()
    ) as Array<{
      id: string
      kind: string
      canonical_name: string
      gloss: string | null
      git_repo: string | null
      source_kind: string
    }>
    return rows.map(toEntityRow)
  }

  listAliases(entityId: string): EntityAliasRow[] {
    const rows = this.db
      .prepare(
        'SELECT entity_id, alias, normalized, source FROM entity_aliases WHERE entity_id = ?'
      )
      .all(entityId) as Array<{
      entity_id: string
      alias: string
      normalized: string
      source: string
    }>
    return rows.map(r => ({
      entityId: r.entity_id,
      alias: r.alias,
      normalized: r.normalized,
      source: r.source,
    }))
  }

  entityCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM entities WHERE tombstoned_at IS NULL')
      .get() as { n: number }
    return row.n
  }

  /** Live entities linked to any of the given fact ids. Empty input → empty result. */
  entitiesForFactIds(factIds: string[]): EntityRow[] {
    if (factIds.length === 0) return []
    const placeholders = factIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.id, e.kind, e.canonical_name, e.gloss, e.git_repo, e.source_kind
         FROM entities e
         JOIN entity_links l ON l.entity_id = e.id
         WHERE e.tombstoned_at IS NULL AND l.fact_id IN (${placeholders})`
      )
      .all(...factIds) as Array<{
      id: string
      kind: string
      canonical_name: string
      gloss: string | null
      git_repo: string | null
      source_kind: string
    }>
    return rows.map(toEntityRow)
  }

  /** Fact ids linked to any of the given entities. Unlinked facts are never returned. */
  linkedFactIds(entityIds: string[]): string[] {
    if (entityIds.length === 0) return []
    const placeholders = entityIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT DISTINCT fact_id FROM entity_links WHERE entity_id IN (${placeholders})`)
      .all(...entityIds) as Array<{ fact_id: string }>
    return rows.map(r => r.fact_id)
  }

  hasLinks(entityId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM entity_links WHERE entity_id = ? LIMIT 1')
      .get(entityId) as { x: number } | undefined
    return Boolean(row)
  }

  /**
   * All typed edges touching an entity, in both directions, with the neighbor
   * resolved. `direction` is relative to the queried entity: `out` means the
   * entity is the edge's `from` side (it depends on / belongs to the neighbor),
   * `in` means the neighbor points at it (the neighbor is part of it).
   *
   * `distinct_from` rows are excluded — they are a disambiguation signal, not a
   * relationship, and `distinctFromSiblings` is their accessor.
   */
  listEdges(entityId: string): EntityEdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT from_entity_id, to_entity_id, edge_type, gloss FROM entity_edges
         WHERE edge_type != 'distinct_from' AND (from_entity_id = ? OR to_entity_id = ?)`
      )
      .all(entityId, entityId) as Array<{
      from_entity_id: string
      to_entity_id: string
      edge_type: string
      gloss: string | null
    }>
    const out: EntityEdgeRow[] = []
    for (const row of rows) {
      const outgoing = row.from_entity_id === entityId
      const other = this.getEntityById(outgoing ? row.to_entity_id : row.from_entity_id)
      if (!other) continue
      out.push({
        edgeType: row.edge_type as EntityEdgeType,
        direction: outgoing ? 'out' : 'in',
        other,
        ...(row.gloss ? { gloss: row.gloss } : {}),
      })
    }
    return out
  }

  /** `distinct_from` siblings of an entity (either direction). */
  distinctFromSiblings(entityId: string): EntityCollision[] {
    const rows = this.db
      .prepare(
        `SELECT from_entity_id, to_entity_id, gloss FROM entity_edges
         WHERE edge_type = 'distinct_from' AND (from_entity_id = ? OR to_entity_id = ?)`
      )
      .all(entityId, entityId) as Array<{
      from_entity_id: string
      to_entity_id: string
      gloss: string | null
    }>
    const out: EntityCollision[] = []
    for (const row of rows) {
      const otherId = row.from_entity_id === entityId ? row.to_entity_id : row.from_entity_id
      const self = this.getEntityById(entityId)
      const other = this.getEntityById(otherId)
      if (self && other) {
        out.push({ fromEntity: self, toEntity: other, ...(row.gloss ? { gloss: row.gloss } : {}) })
      }
    }
    return out
  }

  listCollisions(): EntityCollision[] {
    const rows = this.db
      .prepare(
        `SELECT from_entity_id, to_entity_id, gloss FROM entity_edges WHERE edge_type = 'distinct_from'`
      )
      .all() as Array<{ from_entity_id: string; to_entity_id: string; gloss: string | null }>
    const out: EntityCollision[] = []
    for (const row of rows) {
      const from = this.getEntityById(row.from_entity_id)
      const to = this.getEntityById(row.to_entity_id)
      if (from && to) {
        out.push({ fromEntity: from, toEntity: to, ...(row.gloss ? { gloss: row.gloss } : {}) })
      }
    }
    return out
  }

  /**
   * Deterministic collision screen: any two live entities whose normalized names
   * are substrings of each other (token-boundary) but which are different rows
   * get a `distinct_from` edge with a deterministic contrastive gloss. The LLM
   * assembly pass may later replace the gloss with a human-grade one; detection
   * itself never needs a model.
   */
  detectCollisions(): number {
    const entities = this.listEntities()
    // Normalize each name once (O(n)) instead of re-normalizing inside the O(n²) pair scan,
    // where every name would otherwise be re-tokenized ~n times.
    const normalized = entities.map(e => normalizeEntityName(e.canonicalName))
    let written = 0
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i]
      const na = normalized[i]
      if (!a) continue
      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j]
        const nb = normalized[j]
        if (!b) continue
        if (na === nb) continue // same name, different kind — upsert key already separates them
        if (!isTokenBoundarySubstring(na, nb) && !isTokenBoundarySubstring(nb, na)) continue
        this.addEdge(a.id, b.id, 'distinct_from', contrastiveGloss(a, b))
        written++
      }
    }
    return written
  }

  /**
   * Resolve entity mentions in free text by longest-alias match over normalized
   * tokens. Longer aliases consume their span first, so "internal services"
   * binds to the surface before "internal" can claim the substring.
   */
  resolveMentions(text: string): MentionMatch[] {
    const aliases = this.db
      .prepare(
        `SELECT a.entity_id, a.alias, a.normalized FROM entity_aliases a
         JOIN entities e ON e.id = a.entity_id
         WHERE e.tombstoned_at IS NULL`
      )
      .all() as Array<{ entity_id: string; alias: string; normalized: string }>
    if (aliases.length === 0) return []

    const tokens = tokenizeWithSpans(text)
    if (tokens.length === 0) return []

    // Sort by token length descending so longest aliases claim spans first.
    // Recompute the match key from the raw alias so CamelCase splitting applies
    // even when `entity_aliases.normalized` was written by an older normalizer.
    const sorted = aliases
      .map(a => {
        const normalized = normalizeEntityName(a.alias)
        return {
          ...a,
          normalized,
          tokenCount: normalized ? normalized.split(' ').length : 0,
        }
      })
      .filter(a => a.tokenCount > 0)
      .sort((x, y) => y.tokenCount - x.tokenCount || y.normalized.length - x.normalized.length)

    const claimed = new Array<boolean>(tokens.length).fill(false)
    const matches: MentionMatch[] = []
    for (const alias of sorted) {
      const aliasTokens = alias.normalized.split(' ')
      for (let i = 0; i + aliasTokens.length <= tokens.length; i++) {
        let ok = true
        for (let k = 0; k < aliasTokens.length; k++) {
          const token = tokens[i + k]
          if (claimed[i + k] || !token || token.norm !== aliasTokens[k]) {
            ok = false
            break
          }
        }
        if (!ok) continue
        const first = tokens[i]
        const last = tokens[i + aliasTokens.length - 1]
        if (!first || !last) continue
        for (let k = 0; k < aliasTokens.length; k++) claimed[i + k] = true
        const entity = this.getEntityById(alias.entity_id)
        if (entity) {
          const surface = text.slice(first.start, last.end)
          matches.push({
            entity,
            alias: alias.alias,
            start: first.start,
            end: last.end,
            distinctive: isDistinctiveAliasMatch(alias.alias, surface),
          })
        }
      }
    }
    return matches
  }
}

function toEntityRow(row: {
  id: string
  kind: string
  canonical_name: string
  gloss: string | null
  git_repo: string | null
      source_kind: string
}): EntityRow {
  return {
    id: row.id,
    kind: row.kind as EntityKind,
    canonicalName: row.canonical_name,
    ...(row.gloss ? { gloss: row.gloss } : {}),
    ...(row.git_repo ? { gitRepo: row.git_repo } : {}),
    sourceKind: row.source_kind,
  }
}

/** True when `needle` appears in `haystack` on whole-token boundaries. */
function isTokenBoundarySubstring(needle: string, haystack: string): boolean {
  if (needle === haystack) return false
  const hTokens = haystack.split(' ')
  const nTokens = needle.split(' ')
  for (let i = 0; i + nTokens.length <= hTokens.length; i++) {
    let ok = true
    for (let k = 0; k < nTokens.length; k++) {
      if (hTokens[i + k] !== nTokens[k]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

function contrastiveGloss(a: EntityRow, b: EntityRow): string {
  const describe = (e: EntityRow) =>
    `\`${e.canonicalName}\` is a ${e.kind}${e.gitRepo ? ` in repo ${e.gitRepo}` : ''}`
  return `${describe(a)}; ${describe(b)}. They are different things — do not conflate.`
}

interface TokenSpan {
  norm: string
  start: number
  end: number
}

function tokenizeWithSpans(text: string): TokenSpan[] {
  const out: TokenSpan[] = []
  // Keep original spans for surface casing checks, but split CamelCase inside each
  // alnum run so "HttpRequestHandler" tokenizes like the normalized alias
  // (`http request handler`) rather than as one fused blob.
  const re = /[a-zA-Z0-9]+/g
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    const raw = m[0]
    const base = m.index
    const pieces = normalizeEntityName(raw).split(' ').filter(Boolean)
    if (pieces.length <= 1) {
      out.push({ norm: raw.toLowerCase(), start: base, end: base + raw.length })
    } else {
      // Approximate per-piece spans inside the CamelCase run for distinctiveness
      // checks (surface casing). Offsets follow the raw identifier left-to-right.
      let cursor = 0
      for (const piece of pieces) {
        const rel = raw.toLowerCase().indexOf(piece, cursor)
        const start = rel >= 0 ? base + rel : base + cursor
        const end = start + piece.length
        out.push({ norm: piece, start, end })
        cursor = rel >= 0 ? rel + piece.length : cursor + piece.length
      }
    }
    m = re.exec(text)
  }
  return out
}
