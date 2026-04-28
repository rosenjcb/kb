import type Database from 'better-sqlite3'

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
]

/**
 * Apply any unapplied migrations to the database in order.
 * Safe to call on every open — already-applied migrations are skipped.
 */
export function runMigrations(db: Database.Database): void {
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
