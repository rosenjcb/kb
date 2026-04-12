# Specify markdown storage layout

## Ticket ID
007

## Theme
local-kb

## Problem
This capability is required to move from the current harness to a production-grade knowledge base utility with MCP support.

## Scope
- Define expected behavior and explicit non-goals.
- Specify request and response shape.
- Define edge cases and failure conditions.
- Add concrete examples for implementation handoff.

## Acceptance Criteria
- A clear and reviewable markdown spec exists.
- Inputs, outputs, and error behavior are unambiguous.
- Dependencies and sequencing are explicit.
- Open questions are listed and time-boxed.

## Dependencies
002

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### Markdown Storage Layout (Local KB Directory Structure)

#### Background
The KB stores documents as individual markdown files with a tiny index file. This layout is optimized for simplicity, version control (git), and transparency—documents are human-readable and can be inspected directly. Each document is one file; the index is a markdown table for quick lookups.

#### Approach
Define directory structure, file naming conventions, id generation rules, collision handling, and index format. This layout must work both locally and can be synced to Notion later (ticket 022).

#### Examples / Specifications

**Directory Structure**

```
./kb/
├── .env.local                    # Environment config (git-ignored)
├── sessions/
│   └── documents/               # KB storage (config.kbBaseDir)
│       ├── _table.md            # Index file (all documents listed)
│       ├── authentication-decision.md
│       ├── deployment-constraints.md
│       ├── error-handling-policy.md
│       └── ...
└── .git/                         # Version control
```

**Base Directory Configuration**

```typescript
// From config (Ticket 006)
KB_BASE_DIR=./kb/sessions/documents    # Default or override

// In code
const writer = new MarkdownMDWriterTool({
  baseDir: config.kbBaseDir         // Resolved at startup
})
```

**Document File Format**

Each document file: `{id}.md`

```markdown
# Authentication Architecture Decision

Created: 2026-04-12T14:35:22Z
Tags: architecture, decision, security

## Overview

We use JWT for session tokens...

## Implementation

[document content continues]
```

**File Name Rules**

| Aspect | Rule | Example |
|--------|------|---------|
| **ID format** | Kebab-case; alphanumeric + hyphens only | `auth-decision`, `deployment-v2` |
| **ID length** | Max 80 characters | `authentication-architecture-decision-v2` (52 chars) |
| **File name** | `{id}.md` | `auth-decision.md` |
| **Collision suffix** | `{id}-{timestamp}.md` where timestamp is `Date.now().toString(36)` | `auth-decision-1gvq5m8.md` |
| **Index file** | `_table.md` (always) | `_table.md` |

**ID Generation**

```typescript
function sanitizeId(input: string): string {
  // Lowercase + remove non-alphanumeric (except hyphens)
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')      // Replace sequences with single hyphen
    .replace(/^-+|-+$/g, '')            // Strip leading/trailing hyphens
    .slice(0, 80)                       // Cap at 80 chars
    || 'document'                       // Fallback if empty
}

// Examples:
sanitizeId('Authentication Decision')        → 'authentication-decision'
sanitizeId('Deploy (v2) NEW!!!')              → 'deploy-v2-new'
sanitizeId('error-handling-policy')           → 'error-handling-policy' (already valid)
```

**Collision Handling**

When writing a document with `overwrite=false` (default):

1. Try to write to primary path: `{baseDir}/{id}.md`
2. If file exists → error with "document already exists"
3. Agent must either:
   - Provide new title (generates new id)
   - Use `overwrite=true` to replace existing

When writing a document with `overwrite=true`:

1. Write to primary path: `{baseDir}/{id}.md` (replaces any existing)
2. Return result with that id

**Internal handling (if collision occurs before write):**

```typescript
const primaryPath = path.join(baseDir, `${id}.md`)

try {
  await writeFile(primaryPath, content, { flag: 'wx' })  // 'wx' = fail if exists
} catch (err) {
  if (err.code === 'EEXIST') {
    // Generate unique suffix using timestamp
    const suffix = Date.now().toString(36)  // e.g., '1gvq5m8'
    const uniquePath = path.join(baseDir, `${id}-${suffix}.md`)
    await writeFile(uniquePath, content)
    // Return result with unique id, NOT primary id
  } else {
    throw err
  }
}
```

#### Index File Format (`_table.md`)

Markdown table with one row per document. Updated every time a document is written.

**Example `_table.md`:**

```markdown
# TinySQL Document Table

| id | title | path | updated_at |
| --- | --- | --- | --- |
| auth-decision | Authentication Architecture Decision | kb/sessions/documents/auth-decision.md | 2026-04-12T14:35:22Z |
| deploy-constraints | Deployment Model and Constraints | kb/sessions/documents/deploy-constraints.md | 2026-04-12T14:40:15Z |
| error-handling | Error Handling Policy | kb/sessions/documents/error-handling.md | 2026-04-12T14:42:30Z |
```

**Index Update Logic**

When a document is written:

```typescript
async function upsertIndex(result: WriteDocumentResult): Promise<void> {
  const indexPath = path.join(baseDir, '_table.md')
  
  // 1. Load existing index or create new
  let lines: string[] = [
    '# TinySQL Document Table',
    '',
    '| id | title | path | updated_at |',
    '| --- | --- | --- | --- |',
  ]
  try {
    const existing = await readFile(indexPath, 'utf8')
    lines = existing.split('\n')
  } catch {
    // File doesn't exist; use default header
  }

  // 2. Escape pipe characters in title (markdown escaping)
  const title = result.title.replace(/\|/g, '\\|')
  
  // 3. Build new row
  const newRow = `| ${result.id} | ${title} | ${result.filePath} | ${result.updatedAt} |`

  // 4. Find and update existing row or append
  const rowPrefix = `| ${result.id} |`
  const rowIndex = lines.findIndex(line => line.startsWith(rowPrefix))
  if (rowIndex >= 0) {
    lines[rowIndex] = newRow  // Update existing
  } else {
    lines.push(newRow)        // Append new
  }

  // 5. Write back
  await writeFile(indexPath, lines.join('\n').trim() + '\n', 'utf8')
}
```

**Index Escaping Rules**

| Character | Escaping |
|-----------|----------|
| `\|` | Escape to `\\|` (pipe used as table delimiter) |
| `\n` | Strip (newlines not allowed in table cells) |
| Other markdown | No escaping needed (safe in table cells) |

#### Document Metadata (Front Matter)

Each markdown file includes lightweight metadata:

```markdown
# Title

Created: 2026-04-12T14:35:22Z
Tags: tag1, tag2, tag3

[Content starts here]
```

**Metadata Rules**

| Field | Format | Required | Notes |
|-------|--------|----------|-------|
| **Title** | H1 (first line) | ✓ | Must be first line |
| **Created** | ISO 8601 | ✓ | Set at creation, never changes |
| **Tags** | Comma-separated | ✗ | Optional; for indexing |

#### Edge Cases & Error Conditions

| Scenario | Behavior |
|----------|----------|
| KB base directory doesn't exist | Create automatically (`mkdir -p`) |
| Disk full | Throw storage error (ticket 005) |
| Invalid file name (special chars) | Sanitize via `sanitizeId()` |
| Pipe in title | Escape as `\\|` in index |
| Newline in title or content | Strip from title; preserve in content |
| Concurrent writes to same ID | First write succeeds; second gets conflict error (409) |
| Index file corrupted | Rebuild on next write (re-create all rows) |

#### Query/Search Not Included (Future)

This spec covers **storage layout only**. Searching/querying documents:
- Ticket 008 or 009 will cover index format for search
- Ticket 018 (MCP tool) will implement `read_documents` query

#### Integration Points

- **Ticket 002**: DocumentWriter interface; this ticket implements it
- **Ticket 006**: config.kbBaseDir comes from environment
- **Ticket 008**: Collision handling ties to naming policy
- **Ticket 018-019**: MCP tools query this layout
- **Ticket 022**: Notion backend will map this layout to Notion pages

#### Decisions Made

- ✅ **One file per document**: Simple, version-controllable, no database needed
- ✅ **Index file in markdown**: Human-readable, can be viewed in git
- ✅ **ID sanitization**: Kebab-case, 80 char limit
- ✅ **Collision handling**: Timestamp suffix (not overwrite by default)
- ✅ **Metadata in markdown**: Created timestamp + tags in file header
- ✅ **Path storage in index**: For quick file lookup

#### Open Questions (Time-boxed or Future)

- **Soft delete**: Should deleted docs move to `.archive/` or hard-delete? → **Future ticket (retention policy).**
- **Compression**: Should old documents be gzipped to save space? → **Future (storage optimization).**
- **Full-text search**: Should index include content snippets? → **Future (search index, ticket 008).**
- **Version history**: Should we keep all document versions or just latest? → **Future (audit trail, ticket 033).**
- **TinySQL store**: Currently using markdown + index table; future versions should support SQLite for richer queries → **Future ticket (persistence abstraction, v1.1).**
- **Vector embeddings**: Should we store document embeddings for semantic search? → **Future ticket (vector search integration, v1.2).**

#### Validation & Closure

This implementation plan establishes:
- ✅ Directory structure: `{baseDir}/{id}.md` + `_table.md` index
- ✅ ID format: kebab-case, max 80 chars, sanitized
- ✅ File format: Markdown with title, Created timestamp, optional Tags
- ✅ Index format: Markdown table with id, title, path, updated_at
- ✅ Collision handling: Timestamp suffix (e.g., `id-1gvq5m8.md`)
- ✅ Metadata escaping: Pipe characters escaped for markdown tables
- ✅ Error conditions documented

**Ticket 007 is now closed.**
