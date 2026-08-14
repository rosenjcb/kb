import type { DatabaseSync } from 'node:sqlite'

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        doc_type TEXT,
        lane TEXT,
        tags_json TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        lane TEXT,
        heading_path TEXT,
        chunk_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        UNIQUE (doc_id, chunk_index)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id,
        doc_id,
        chunk_text,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retrieval_miss_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        raw_query TEXT NOT NULL,
        stage TEXT NOT NULL,
        miss_reason TEXT NOT NULL,
        top_candidates_json TEXT NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_miss_events_fingerprint
        ON retrieval_miss_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_ranking_hints (
        query_fingerprint TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 0,
        hint_score REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (query_fingerprint, doc_id)
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_ranking_hints_fingerprint
        ON retrieval_ranking_hints(query_fingerprint, hint_score DESC);

      CREATE TABLE IF NOT EXISTS retrieval_checkpoint_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        confidence REAL NOT NULL,
        method TEXT NOT NULL,
        detail TEXT,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_stage
        ON retrieval_checkpoint_events(stage, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_fingerprint
        ON retrieval_checkpoint_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_lane_routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        primary_lane TEXT NOT NULL,
        routed_lanes_json TEXT NOT NULL,
        route_reason TEXT NOT NULL,
        used_fallback INTEGER NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        confidence REAL NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_lane
        ON retrieval_lane_routing_events(primary_lane, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_fingerprint
        ON retrieval_lane_routing_events(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_entries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date  TEXT NOT NULL,
        base          TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        metadata_json TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_entries_date
        ON session_entries(session_date DESC);

      CREATE INDEX IF NOT EXISTS idx_session_entries_base
        ON session_entries(base, session_date DESC);
    `,
  },
  {
    version: 2,
    name: 'add_content_column',
    sql: `ALTER TABLE documents ADD COLUMN content TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 3,
    name: 'add_is_original_column',
    sql: 'ALTER TABLE documents ADD COLUMN is_original INTEGER NOT NULL DEFAULT 0;',
  },
  {
    version: 4,
    name: 'add_retrieval_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS retrieval_runs (
        run_id TEXT PRIMARY KEY,
        query_fingerprint TEXT NOT NULL,
        raw_query TEXT NOT NULL,
        total_iterations INTEGER NOT NULL,
        hypotheses_count INTEGER NOT NULL,
        final_coverage_score REAL NOT NULL,
        winning_branch_id TEXT,
        surface TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_runs_fingerprint
        ON retrieval_runs(query_fingerprint, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_hypotheses (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_id TEXT,
        query TEXT NOT NULL,
        mode TEXT NOT NULL,
        lanes_json TEXT,
        source TEXT NOT NULL,
        depth INTEGER NOT NULL,
        result_count INTEGER,
        best_score REAL,
        novelty REAL,
        pruned INTEGER NOT NULL DEFAULT 0,
        prune_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_hypotheses_run
        ON retrieval_hypotheses(run_id);
    `,
  },
  {
    version: 5,
    name: 'facts_first_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        fact_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        supersedes_fact_id TEXT,
        tombstoned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_normalized_live
        ON facts(normalized_text)
        WHERE tombstoned_at IS NULL;

      CREATE TABLE IF NOT EXISTS fact_concepts (
        fact_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'context',
        score REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, concept_id, role),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS fact_edges (
        from_fact_id TEXT NOT NULL,
        to_fact_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_fact_id, to_fact_id, edge_type),
        FOREIGN KEY (from_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
        FOREIGN KEY (to_fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        fact_id UNINDEXED,
        fact_text,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS fact_embeddings (
        fact_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS derived_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        tags_json TEXT,
        doc_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS original_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_ref TEXT,
        tags_json TEXT,
        doc_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: 'facts_lane_id',
    sql: `
      ALTER TABLE facts ADD COLUMN lane_id TEXT NOT NULL DEFAULT 'general';
      CREATE INDEX IF NOT EXISTS idx_facts_lane_id ON facts(lane_id);
    `,
  },
  {
    version: 7,
    name: 'doctype_redesign_remap_legacy',
    sql: `
      UPDATE documents     SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE documents     SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
      UPDATE derived_docs  SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE derived_docs  SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
      UPDATE original_docs SET doc_type = 'reference' WHERE doc_type = 'architecture';
      UPDATE original_docs SET doc_type = 'runbook'   WHERE doc_type = 'checklist';
    `,
  },
  {
    // Facts-first triplet schema: every fact row carries an explicit
    // (subject, predicate, object) triple. Existing rows backfill to '' and
    // are tombstoned by application code on next write — bases are expected
    // to be rebuilt from scratch under the new ingest pipeline.
    version: 8,
    name: 'facts_triplet_columns',
    sql: `
      ALTER TABLE facts ADD COLUMN subject   TEXT NOT NULL DEFAULT '';
      ALTER TABLE facts ADD COLUMN predicate TEXT NOT NULL DEFAULT '';
      ALTER TABLE facts ADD COLUMN object    TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_facts_subject_live
        ON facts(subject) WHERE tombstoned_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_predicate_live
        ON facts(predicate) WHERE tombstoned_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_object_live
        ON facts(object) WHERE tombstoned_at IS NULL;
    `,
  },
  {
    version: 9,
    name: 'kb_graph_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS kb_graph_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'concept',
        doc_id TEXT,
        description TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kb_graph_relationships (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        doc_id TEXT,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_graph_rel_from
        ON kb_graph_relationships(from_id);
      CREATE INDEX IF NOT EXISTS idx_kb_graph_rel_to
        ON kb_graph_relationships(to_id);
      CREATE INDEX IF NOT EXISTS idx_kb_graph_rel_doc
        ON kb_graph_relationships(doc_id);
    `,
  },
  {
    version: 10,
    name: 'code_graph_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subkind TEXT,
        name TEXT NOT NULL,
        qualified_name TEXT,
        path TEXT,
        file_id TEXT,
        language TEXT,
        span_start INTEGER,
        span_end INTEGER,
        exported INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        props_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kg_nodes_kind ON kg_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_file_id ON kg_nodes(file_id);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_path ON kg_nodes(path);

      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        props_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (from_id) REFERENCES kg_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id) REFERENCES kg_nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_to ON kg_edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type);

      CREATE TABLE IF NOT EXISTS kg_file_state (
        file_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        extractor TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        indexed_at TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error_text TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
        id UNINDEXED,
        name,
        qualified_name,
        path,
        tokenize='unicode61'
      );
    `,
  },
  {
    version: 11,
    name: 'drop_kb_graph_tables',
    sql: `
      DROP TABLE IF EXISTS kb_graph_relationships;
      DROP TABLE IF EXISTS kb_graph_entities;
    `,
  },
  {
    version: 12,
    name: 'facts_source_text',
    sql: 'ALTER TABLE facts ADD COLUMN source_text TEXT;',
  },
  {
    version: 13,
    name: 'fact_categories',
    sql: `
      CREATE TABLE IF NOT EXISTS fact_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        representative_terms_json TEXT NOT NULL DEFAULT '[]',
        centroid_vector_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_categories_name
        ON fact_categories(name);

      CREATE TABLE IF NOT EXISTS fact_category_assignments (
        fact_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, category_id),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES fact_categories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_fact_category_assignments_category
        ON fact_category_assignments(category_id, score DESC);
    `,
  },
  {
    version: 14,
    name: 'unify_facts_drop_kg_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS code_file_state (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        extractor TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      DROP TABLE IF EXISTS kg_nodes_fts;
      DROP TABLE IF EXISTS kg_edges;
      DROP TABLE IF EXISTS kg_nodes;
      DROP TABLE IF EXISTS kg_file_state;
      DROP TABLE IF EXISTS kg_semantic_bridge;
    `,
  },
  {
    // Multi-repo bases: every fact records which git repo it came from (slug).
    // Nullable — rows written before this version stay NULL until the next scan
    // re-writes them with their repo slug (opportunistic backfill, no data migration).
    version: 15,
    name: 'add_facts_git_repo',
    sql: `
      ALTER TABLE facts ADD COLUMN git_repo TEXT;
      CREATE INDEX IF NOT EXISTS idx_facts_git_repo
        ON facts(git_repo) WHERE tombstoned_at IS NULL;
    `,
  },
  {
    // Fact categories were replaced by repo-based organisation (facts.git_repo).
    version: 16,
    name: 'drop_fact_categories',
    sql: `
      DROP TABLE IF EXISTS fact_category_assignments;
      DROP TABLE IF EXISTS fact_categories;
    `,
  },
  {
    // Organizational Ontology Index (packages/kb-core/src/tools/ECOSYSTEM_HARVESTERS.spec.md): canonical named
    // things (services, surfaces, domains, repos, …) with aliases, typed edges
    // (`distinct_from` is the anti-conflation edge), and fact↔entity links that
    // partition the fact pool for query-time scope inference. All four tables are
    // inert until an entity-index scan cycle populates them.
    version: 17,
    name: 'add_entity_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS entities (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        gloss          TEXT,
        git_repo       TEXT,
        source_kind    TEXT NOT NULL,
        content_hash   TEXT,
        confidence     REAL NOT NULL DEFAULT 0.9,
        tombstoned_at  TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_kind_name_live
        ON entities(kind, canonical_name)
        WHERE tombstoned_at IS NULL;

      CREATE TABLE IF NOT EXISTS entity_aliases (
        entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        alias      TEXT NOT NULL,
        normalized TEXT NOT NULL,
        source     TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        PRIMARY KEY (entity_id, normalized)
      );

      CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized
        ON entity_aliases(normalized);

      CREATE TABLE IF NOT EXISTS entity_edges (
        from_entity_id TEXT NOT NULL,
        to_entity_id   TEXT NOT NULL,
        edge_type      TEXT NOT NULL,
        gloss          TEXT,
        weight         REAL NOT NULL DEFAULT 1.0,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (from_entity_id, to_entity_id, edge_type)
      );

      CREATE TABLE IF NOT EXISTS entity_links (
        fact_id    TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        PRIMARY KEY (fact_id, entity_id, role)
      );

      CREATE INDEX IF NOT EXISTS idx_entity_links_entity
        ON entity_links(entity_id);
    `,
  },
  {
    // Drop the hand-assigned weights from the entity registry. Every value these
    // columns ever held was a constant typed into ecosystem YAML or a default in
    // the registry — never a measurement — and nothing but a debug print ever read
    // one back. A harvest rule now records only *what* a manifest declares; how far
    // to trust a name is a question for measured signal at query time, not a number
    // chosen when the rule was written.
    //
    // Every database reaching this migration has had 17 applied, so the columns
    // exist and each DROP is total.
    version: 18,
    name: 'drop_entity_registry_weights',
    sql: `
      ALTER TABLE entities      DROP COLUMN confidence;
      ALTER TABLE entity_aliases DROP COLUMN confidence;
      ALTER TABLE entity_links  DROP COLUMN confidence;
      ALTER TABLE entity_edges  DROP COLUMN weight;
    `,
  },
  {
    // Retrieval telemetry records a categorical evidence label, not a float. The
    // old `confidence REAL` held the output of a hand-tuned blend that four
    // separate consumers each re-thresholded with their own invented cut-point;
    // the label is decided once now (`core/evidence-label`) and compared as an
    // ordered category.
    //
    // Recreated rather than altered: no production code path writes these tables
    // (the recorder has no callers), the readers only aggregate `status` and
    // `next_action` and never read the dropped column, and DROP/CREATE is the one
    // form that is correct whether or not the table exists in a given database.
    version: 19,
    name: 'retrieval_events_evidence_label',
    sql: `
      DROP TABLE IF EXISTS retrieval_checkpoint_events;
      CREATE TABLE retrieval_checkpoint_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        evidence TEXT NOT NULL,
        method TEXT NOT NULL,
        detail TEXT,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_stage
        ON retrieval_checkpoint_events(stage, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_checkpoint_events_fingerprint
        ON retrieval_checkpoint_events(query_fingerprint, created_at DESC);

      DROP TABLE IF EXISTS retrieval_lane_routing_events;
      CREATE TABLE retrieval_lane_routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_fingerprint TEXT NOT NULL,
        primary_lane TEXT NOT NULL,
        routed_lanes_json TEXT NOT NULL,
        route_reason TEXT NOT NULL,
        used_fallback INTEGER NOT NULL,
        status TEXT NOT NULL,
        next_action TEXT NOT NULL,
        evidence TEXT NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_lane
        ON retrieval_lane_routing_events(primary_lane, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_retrieval_lane_routing_events_fingerprint
        ON retrieval_lane_routing_events(query_fingerprint, created_at DESC);
    `,
  },
  {
    // Facts carry an evidence *kind*, not a confidence float. The float was a
    // per-write-site constant standing in for "what kind of fact is this"
    // (0.3 an import edge, 0.7 an `extends` edge, 0.6 a doc sentence); the label
    // says that outright and the ranking weight moves to one table in
    // `core/fact-evidence`. Storing the label means those weights can be retuned
    // and re-measured without reindexing a single fact.
    //
    // Existing rows are mapped back through the constants they were written with,
    // so ranking is unchanged across the migration. Anything unrecognized lands on
    // `curated`, matching the old `?? 0.8` default.
    version: 20,
    name: 'facts_evidence_kind',
    sql: `
      ALTER TABLE facts ADD COLUMN evidence TEXT NOT NULL DEFAULT 'curated';

      UPDATE facts SET evidence = CASE
        WHEN confidence <= 0.40  THEN 'incidental'
        WHEN confidence <= 0.575 THEN 'contextual'
        WHEN confidence <= 0.625 THEN 'descriptive'
        WHEN confidence <= 0.675 THEN 'declarative'
        WHEN confidence <= 0.75  THEN 'definitional'
        ELSE 'curated'
      END;

      ALTER TABLE facts DROP COLUMN confidence;
    `,
  },
  {
    // Major clean-slate: retire the sentence-level fact graph. Index whole markdown
    // documents + AST code symbols, linked by a flat doc_code_links table. No
    // fact_edges / fact_concepts / traversable graph. Existing bases must reindex.
    version: 21,
    name: 'document_symbol_index',
    sql: `
      DROP TABLE IF EXISTS entity_links;
      DROP TABLE IF EXISTS fact_embeddings;
      DROP TABLE IF EXISTS facts_fts;
      DROP TABLE IF EXISTS fact_edges;
      DROP TABLE IF EXISTS fact_concepts;
      DROP TABLE IF EXISTS facts;
      DROP TABLE IF EXISTS chunk_embeddings;
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS documents;

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        git_repo TEXT NOT NULL DEFAULT '',
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (git_repo, rel_path)
      );

      CREATE INDEX idx_documents_git_repo
        ON documents(git_repo);

      CREATE VIRTUAL TABLE documents_fts USING fts5(
        doc_id UNINDEXED,
        body,
        tokenize='porter unicode61'
      );

      CREATE TABLE doc_embeddings (
        doc_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE TABLE code_symbols (
        id TEXT PRIMARY KEY,
        git_repo TEXT NOT NULL DEFAULT '',
        rel_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_text TEXT,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (git_repo, rel_path, name)
      );

      CREATE INDEX idx_code_symbols_git_repo
        ON code_symbols(git_repo);

      CREATE INDEX idx_code_symbols_name
        ON code_symbols(name);

      CREATE VIRTUAL TABLE code_symbols_fts USING fts5(
        symbol_id UNINDEXED,
        name,
        source_text,
        tokenize='porter unicode61'
      );

      CREATE TABLE code_embeddings (
        symbol_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );

      CREATE TABLE doc_code_links (
        doc_id TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 1.0,
        link_kind TEXT NOT NULL DEFAULT 'relates_to',
        PRIMARY KEY (doc_id, symbol_id),
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_doc_code_links_symbol
        ON doc_code_links(symbol_id);

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        git_repo TEXT,
        text TEXT NOT NULL,
        source_ref TEXT,
        evidence TEXT NOT NULL DEFAULT 'curated',
        tombstoned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_facts_git_repo_live
        ON facts(git_repo) WHERE tombstoned_at IS NULL;

      CREATE VIRTUAL TABLE facts_fts USING fts5(
        fact_id UNINDEXED,
        text,
        tokenize='porter unicode61'
      );

      CREATE TABLE fact_embeddings (
        fact_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      -- Unit↔entity membership for scope inference. unit ids may be facts, documents, or
      -- code_symbols — no FK so all three can participate under the same table shape.
      CREATE TABLE entity_links (
        fact_id    TEXT NOT NULL,
        entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        PRIMARY KEY (fact_id, entity_id, role)
      );

      CREATE INDEX idx_entity_links_entity
        ON entity_links(entity_id);
    `,
  },
]

/**
 * Highest migration version defined here — the KB index schema version.
 *
 * This is the compatibility token stamped into a kb snapshot manifest
 * (`compat.indexSchema`). Migrations are forward-only, so a consumer whose
 * `LATEST_SCHEMA_VERSION` is >= a snapshot's `indexSchema` can open and migrate
 * it; a consumer that is older cannot (it lacks the newer migrations) and must
 * reject the snapshot rather than silently misread it.
 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
)

/**
 * Apply any unapplied migrations to the database in order.
 * Safe to call on every open — already-applied migrations are skipped.
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      r => r.version
    )
  )

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    try {
      db.exec(migration.sql)
    } catch (err) {
      // Treat "duplicate column name" as a no-op — the column already exists
      // from a newer CREATE TABLE definition, so the migration is effectively applied.
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('duplicate column name')) throw err
    }
    insert.run(migration.version, migration.name, new Date().toISOString())
  }
}
