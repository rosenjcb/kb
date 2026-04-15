# SQLite-exclusive document storage and `kb init` bootstrap command

## Ticket ID
082

## Theme
storage / onboarding

## Problem

The KB system has three compounding issues that undermine reliability and correctness:

1. **Markdown files are mutable source of truth.** Documents and session logs live in `sessions/namespaces/{base}/documents/*.md`. These files can be edited out-of-band, deleted accidentally, corrupted by partial writes, or go stale relative to the SQLite index. The SQLite store is treated as a secondary index rather than the authority.

2. **Session logs are unstructured markdown.** `session-log-YYYY-MM-DD.md` files are generated as freeform markdown, making them difficult to query programmatically, impossible to enforce schema on, and noisy in retrieval (they are already deprioritized via `isLowSignalSourceId`).

3. **No clean initialization path.** When the KB is corrupted or needs to be rebuilt on a fresh base, there is no first-class command. The only recourse is manual file manipulation. There is no way to bootstrap a new KB from a project's existing README/docs via a structured agent loop.

## Scope

### Objective 1 — SQLite as exclusive document store

- The `documents` table in `.kb-index.sqlite` becomes the **only** place document content lives.
- Add a `content` column to `documents` to store the full document body (markdown text) inline.
- Remove the `file_path` column as a storage locator; retain it as an optional display hint or remove entirely (decided during implementation).
- Replace `MarkdownMDWriterTool` with a `SqliteDocumentWriter` that reads/writes exclusively via the DB.
- Delete all `sessions/namespaces/{base}/documents/*.md` document files and the `_table.md` index after migration.
- All read paths (`markdown-document-reader.ts`, `specialized-document-tools.ts`, `retrieval-checkpoint-orchestrator.ts`) must be updated to query SQLite directly instead of scanning the filesystem.

### Objective 2 — Structured session entries in SQLite

- Add a `session_entries` table to the SQLite schema with a well-defined structure (see schema below).
- Session events written by the CLI (currently `session-log-YYYY-MM-DD.md`) are inserted as rows, not files.
- The `write_document` tool (and its calling code) must route `type: 'session-log'` writes to `session_entries`, not `documents`.
- No new session-log markdown files are ever created after this ticket ships.

### Objective 3 — `kb init` bootstrap command

- A new CLI command `kb init --base <name>` that bootstraps a fresh, coherent KB from scratch.
- The command runs a 5-cycle agent loop reusing the multi-cycle orchestration already built for `kb publish` (`publish-cli.ts`).
- Instead of reading existing KB documents in cycle 1, it reads README/docs from the working directory and **interactively asks the user** targeted questions to fill in gaps.
- Each cycle uses an LLM pass to produce or refine structured fact documents, which are written into the new SQLite store at cycle 5.
- The command replaces any manual "seed the KB" workflows.

## Non-Goals

- Bidirectional sync between SQLite and the filesystem (SQLite wins, no sync).
- Keeping `_table.md` alive in any form after the migration.
- Migrating old corrupted bases automatically (operator runs `kb init` for that).
- Changing the retrieval scoring or lane-routing logic in this ticket.

## Acceptance Criteria

- `kb submit`, `kb query`, `kb validate`, `kb dispute`, and `kb chat` all operate exclusively from SQLite — no filesystem reads for document content.
- `sessions/namespaces/{base}/documents/` directory is absent (or empty) after migration; no new files are written there.
- `session_entries` table captures all session activity that was previously written to `session-log-*.md`.
- `kb init --base <name>` bootstraps a new SQLite DB at the standard path, runs 5 cycles, and outputs a summary of written facts.
- `kb init` accepts `--dry-run` (prints what would be asked/written, no mutations) and `--apply` (full run).
- `kb init --resume-from <checkpoint>` is supported to restart after a failed or interrupted run.
- All existing tests pass; new tests cover the SQLite write path and `kb init` happy path.

## Dependencies

- 064 (SQLite index schema and indexer — existing schema foundation)
- 010 (session lifecycle spec — informs what session_entries must capture)
- 011 (decision log schema — informs session_entries metadata column shape)
- 080/081 (publish-cli multi-cycle orchestration — code to be reused by `kb init`)

## Deliverables

- Schema migration adding `content` column to `documents` and new `session_entries` table.
- `SqliteDocumentWriter` class replacing `MarkdownMDWriterTool` as the default writer.
- Updated read paths in `markdown-document-reader.ts` and `specialized-document-tools.ts`.
- `src/cli/init-cli.ts` — 5-cycle init orchestrator.
- CLI wiring in `src/cli/index.ts` for the `kb init` command.
- Migration script / runbook for converting existing markdown-based bases to SQLite.
- Tests in `tests/cli/` and `tests/tools/`.

## Estimate
XL

## Priority
High

---

## Proposed Schema Changes

### `documents` table — add `content` column

```sql
ALTER TABLE documents ADD COLUMN content TEXT NOT NULL DEFAULT '';
```

After migration, `file_path` becomes a nullable hint (retained for display only):

```sql
-- future cleanup: allow null after all read paths migrated
ALTER TABLE documents RENAME COLUMN file_path TO file_path_hint;
```

Full documents schema (v2):

```sql
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,           -- full markdown body lives here
  file_path_hint TEXT,                   -- nullable display hint; not used for reads
  doc_type      TEXT,
  lane          TEXT,
  tags_json     TEXT,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);
```

### `session_entries` table — new

```sql
CREATE TABLE IF NOT EXISTS session_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date  TEXT NOT NULL,           -- ISO date: YYYY-MM-DD
  base          TEXT NOT NULL,           -- KB base name (e.g. 'dogfood')
  event_type    TEXT NOT NULL,           -- 'submit' | 'validate' | 'dispute' | 'query' | 'chat' | 'publish' | 'init' | 'tool-call' | 'system'
  summary       TEXT NOT NULL,           -- short human-readable description of the event
  metadata_json TEXT,                    -- arbitrary JSON for event-specific fields
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_entries_date
  ON session_entries(session_date DESC);

CREATE INDEX IF NOT EXISTS idx_session_entries_base
  ON session_entries(base, session_date DESC);
```

Corresponding TypeScript interface:

```typescript
export interface SessionEntry {
  sessionDate: string                  // 'YYYY-MM-DD'
  base: string
  eventType:
    | 'submit'
    | 'validate'
    | 'dispute'
    | 'query'
    | 'chat'
    | 'publish'
    | 'init'
    | 'tool-call'
    | 'system'
  summary: string
  metadata?: Record<string, unknown>   // serialized as metadata_json
}
```

---

## `SqliteDocumentWriter` Interface

Replaces `MarkdownMDWriterTool` as the default implementation of `DocumentWriterExtended`.

```typescript
export class SqliteDocumentWriter implements DocumentWriterExtended {
  constructor(private readonly db: Database.Database) {}

  async writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult> {
    // upsert into documents table, store content inline
  }

  async appendToDocument(input: AppendToDocumentInput): Promise<WriteDocumentResult> {
    // read content from DB, append, update
  }

  async updateDocument(input: UpdateDocumentInput): Promise<WriteDocumentResult> {
    // full content replace in DB
  }

  // ... other operations from DocumentWriterExtended
}
```

Key invariant: **no file writes anywhere in the document write path**. The `baseDir` concept is retired.

---

## `kb init` — 5-Cycle Bootstrap Flow

Reuses the multi-cycle orchestration pattern from `publish-cli.ts` (`pass1`–`pass4` + `wiki-write`).

### Command surface

```bash
kb init --base <name> [--apply | --dry-run] [--stop-after <cycle>] [--resume-from <checkpoint>]
```

### Cycle definitions

| Cycle | Name | What happens |
|-------|------|--------------|
| 1 | `read-inputs` | Discover README, CLAUDE.md, and other docs in working dir. **Interactively ask user** targeted questions to fill gaps (project purpose, key concepts, main commands, architecture notes). Collect answers into a structured context object. |
| 2 | `pass1` | LLM pass: synthesize context object into a candidate set of fact documents (title, content, type, tags). Output as in-memory document list. |
| 3 | `pass2` | LLM refinement pass: check for contradictions, missing context, vague facts. Ask user follow-up questions where confidence is low. Produce revised document list. |
| 4 | `pass3` | LLM quality pass: ensure each document is concise, well-typed, correctly tagged, and retrieval-ready. Final dedup pass. |
| 5 | `write` | Write all documents to `session_entries` + `documents` tables in the new SQLite DB. Emit summary of written doc IDs and coverage report. |

### Interactive question protocol (Cycle 1)

- Questions are printed to stdout one at a time.
- User responds via stdin (same pattern as `kb chat` REPL).
- Questions are generated by the LLM based on gaps in the README analysis.
- A `--non-interactive` flag skips questions and proceeds with only what can be inferred from files.
- A maximum of **10 questions** per init run to avoid fatigue.

### Checkpoint file

Same shape as `PublishCheckpoint` in `publish-cli.ts`:

```typescript
export interface InitCheckpoint {
  version: 1
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext   // answers + README summary from cycle 1
  candidateDocs?: CandidateDoc[]  // working document list between cycles
}
```

### Dry-run behavior

- Cycles 1–4 run normally (LLM calls, user questions).
- Cycle 5 (`write`) is skipped; a diff-style preview of would-be documents is printed.

---

## Migration Plan (existing bases)

For each existing base (e.g. `dogfood`):

1. Run `kb init --base dogfood --apply` on the new codebase. This rebuilds the KB from the README + user answers.
2. After init completes, verify retrieval quality with `kb query "<key facts>"`.
3. Delete the now-redundant `sessions/namespaces/dogfood/documents/` directory.

There is **no automated migration script** to preserve old markdown content verbatim — the intent is to rebuild clean, not to copy corrupted/stale content into SQLite.

---

## Implementation Plan

### SPIKE Plan for `kb init` + SQLite-exclusive storage

#### Scope of This Work (Phase Clarity)

- ✅ Phase 1 (Planning): Complete in this ticket
  - Full schema defined for `documents` (v2) and `session_entries`
  - `SqliteDocumentWriter` interface specified
  - `kb init` 5-cycle flow specified with interactive question protocol
  - Migration runbook defined
- ⏳ Phase 2 (Implementation): This ticket IS the implementation ticket (no separate build ticket)

#### Approach

Ship in two sequential sub-phases:

**Sub-phase A — SQLite-only storage**
1. Add `content` column migration to `SqliteKbIndexer.initSchema()`.
2. Build `SqliteDocumentWriter` implementing `DocumentWriterExtended`.
3. Update `MarkdownMDWriterTool` constructor to emit a deprecation warning; leave class intact for test isolation.
4. Update `kb-tools-registry.ts` to instantiate `SqliteDocumentWriter` by default.
5. Update `markdown-document-reader.ts`: replace `readdir` + file-read loops with `SELECT content FROM documents WHERE ...` queries.
6. Update `specialized-document-tools.ts`: replace file paths with DB reads throughout `reconcileFacts`, `reconcileContradictions`.
7. Add `session_entries` table to schema. Route all session-log writes in `intent-cli.ts` and `chat-cli.ts` to `insertSessionEntry()` helper.
8. Remove `_table.md` generation from `MarkdownMDWriterTool`.

**Sub-phase B — `kb init` command**
1. Create `src/cli/init-cli.ts` with `runKbInit(options)` function.
2. Reuse `PublishProgressReporter` and checkpoint file patterns from `publish-cli.ts`.
3. Implement cycle 1: README/CLAUDE.md discovery + interactive Q&A loop (stdin prompt, max 10 questions).
4. Implement cycles 2–4 as LLM passes over accumulated context (reuse `createProvider` + message loop pattern).
5. Implement cycle 5: batch upsert to `documents` and `session_entries` via `SqliteDocumentWriter`.
6. Wire `kb init` in `src/cli/index.ts`.
7. Add `--dry-run`, `--apply`, `--stop-after`, `--resume-from` flags matching publish-cli conventions.

#### Integration Points

- `src/tools/sqlite-kb-index.ts`: schema migration + `insertSessionEntry()` helper + `readDocumentContent(id)` helper.
- `src/tools/markdown-md-writer-tool.ts`: deprecate; replace default usage with `SqliteDocumentWriter`.
- `src/tools/markdown-document-reader.ts`: replace FS reads with DB content queries.
- `src/tools/specialized-document-tools.ts`: same.
- `src/cli/intent-cli.ts`: route session events to `insertSessionEntry`.
- `src/cli/chat-cli.ts`: route chat session summaries to `insertSessionEntry`.
- `src/cli/publish-cli.ts`: reuse `PublishProgressReporter`, checkpoint types, LLM pass pattern.
- `src/cli/index.ts`: add `init` command branch.

#### Error Conditions / Edge Cases

- `kb init` on an existing base: prompt user to confirm overwrite or diff against existing documents.
- LLM pass produces empty document list: warn and prompt user for more context before proceeding.
- `--resume-from` checkpoint has incompatible version: fail fast with upgrade instructions.
- User ctrl-C during interactive questions: save partial context to checkpoint and exit cleanly.
- SQLite DB missing or locked: fail with diagnostic (path, lock holder hint).

#### Decisions to Be Made During Implementation

- Should `file_path_hint` be retained in `documents` or removed entirely? (recommendation: retain as nullable for display/debugging, remove the NOT NULL constraint).
- Should existing `markdown-document-reader.ts` be renamed to `sqlite-document-reader.ts` or kept as-is with internal changes?
- Should `kb init` auto-detect if the base already has documents and switch to a `--refresh` mode?

#### Validation & Closure

This ticket is closed when:
- ✅ No `.md` files are written under `sessions/namespaces/` by any CLI command.
- ✅ `session_entries` table schema added and live in SQLite.
- ✅ `kb query` returns correct results from SQLite content column (not filesystem).
- ✅ `kb init --base test --apply` completes end-to-end (5 cycles, 13 docs written, verified).
- ✅ `kb init --base dogfood --apply` rebuilds dogfood base; old empty-content legacy rows removed.
- ✅ Legacy environment-variable base fallback removed — config is the only base authority.

**Decisions made during implementation:**
- `file_path` column retained but populated with the doc `id` (not a real path) to satisfy existing UNIQUE constraint without a table rebuild.
- `session_entries` table is schema-complete; routing of live CLI events (submit/chat) to it is a follow-up.
- `reconcileContradictions` in `SqliteDocumentWriter` is conservative (no auto-removal) — mirrors the original behaviour.

**Ticket 082 is now closed.**
