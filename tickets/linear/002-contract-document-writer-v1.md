# Freeze DocumentWriter contract v1

## Ticket ID
002

## Theme
foundation

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
001

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### DocumentWriter Contract (Stable Interface)

#### Background
The `DocumentWriter` interface is the core abstraction for storage operations in the KB. It must remain stable so we can swap implementations (markdown files now, Notion later) without breaking MCP tools or agent integrations.

#### Approach
Define a minimal, interface-first contract that encompasses document identity, creation/update semantics, and error handling. All storage backends (markdown, Notion, future) implement this interface and return the same result shapes.

#### Examples / Specifications

**Type Definitions:**

```typescript
interface WriteDocumentInput {
  title: string              // Human-readable title (required, non-empty)
  content: string            // Markdown body (required)
  tags?: string[]            // Freeform search tags (optional, no vocabulary control yet)
  documentId?: string        // Optional stable ID; if omitted, auto-generated (see below)
  overwrite?: boolean        // If false (default), throw error on ID collision
}

interface WriteDocumentResult {
  id: string                 // Auto-generated ULID or UUID (stable, immutable after creation)
  title: string              // Human-readable title (echoed back)
  filePath: string           // Storage location (e.g., "/Users/.../kb/docs/abc123def456.md")
  createdAt: string          // ISO 8601 timestamp, set once at creation, never changes
  updatedAt: string          // ISO 8601 timestamp, reset on each write
}

interface DocumentWriter {
  writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult>
}
```

**Document ID Generation:**
- When `documentId` is not provided: Generate a ULID (or UUID) server-side. Example: `01ARZ3NDEKTSV4RRFFQ69G5FAV`
- When `documentId` is provided: Use it as-is (client ensures idempotency)
- IDs are immutable after first write; subsequent writes with the same ID update the same document
- No transformation (no kebab-case, no slugification); IDs are opaque strings

**Request/Response Flow (via MCP tool):**

Example 1: Create new document (agent → KB)
```json
{
  "name": "write_document",
  "input": {
    "title": "Authentication Architecture Decision",
    "content": "# Auth Design\n\nWe use JWT for session tokens...",
    "tags": ["architecture", "decision", "security"]
  }
}
```

Response:
```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "title": "Authentication Architecture Decision",
  "filePath": "/kb/docs/01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
  "createdAt": "2026-04-12T14:30:00Z",
  "updatedAt": "2026-04-12T14:30:00Z"
}
```

Example 2: Idempotent update (agent provides explicit documentId)
```json
{
  "name": "write_document",
  "input": {
    "title": "Authentication Architecture Decision",
    "content": "# Auth Design\n\nWe use JWT for session tokens (updated with rate limits)...",
    "tags": ["architecture", "decision", "security"],
    "documentId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "overwrite": true
  }
}
```

Response:
```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "title": "Authentication Architecture Decision",
  "filePath": "/kb/docs/01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
  "createdAt": "2026-04-12T14:30:00Z",
  "updatedAt": "2026-04-12T14:35:22Z"
}
```

#### Error Conditions & Edge Cases

| Condition | HTTP Status | Error Response |
|-----------|------------|-----------------|
| Missing required field (title, content) | 400 | `{"error": "write_document: title is required"}` |
| Empty or whitespace-only title | 400 | `{"error": "write_document: title cannot be empty"}` |
| Title exceeds 256 characters | 400 | `{"error": "write_document: title must be ≤256 characters"}` |
| Tags not an array of strings | 400 | `{"error": "write_document: tags must be an array of strings"}` |
| Document exists (overwrite=false) | 409 | `{"error": "write_document: document 01ARZ3... already exists; use overwrite=true or provide a new title"}` |
| Storage layer error (disk full, etc.) | 500 | `{"error": "write_document: storage error - ${reason}"}` |

#### Client Responsibility & Communication

**Who talks to whom:**
- **Agent (Claude)** → calls MCP tool `write_document` → **MCP server** → **DocumentWriter** implementation
- **MCP server** returns a `WriteDocumentResult` to the agent
- **Agent is responsible** for:
  - Deciding whether to provide an explicit `documentId` (for idempotency)
  - Handling 409 conflict responses (retry with different title, or use `overwrite=true`)
  - Providing meaningful `tags` for later retrieval

#### Decisions Made
- ✅ **ID Generation**: Auto-generated ULID/UUID (not derived from title). Stable, opaque, immutable.
- ✅ **Timestamps**: `createdAt` immutable; `updatedAt` reset on each write. ISO 8601 format.
- ✅ **Conflict Behavior**: `overwrite=false` (default) throws 409 error; agent must explicitly opt-in to replace.
- ✅ **Tags**: Optional freeform strings (no vocabulary control yet; can add taxonomy in future ticket).
- ✅ **Content**: No size limits for now; validated for type only.
- ✅ **Title Validation**: Non-empty, trimmed, max 256 chars (reasonable for index/display).

#### Integration Points
- Ticket 001 (KB Mission) established that agents query KB via MCP; this contract defines the write half.
- Ticket 003 (Violation Schema) will consume this contract (violations reference documents by ID).
- Ticket 007 (Markdown Storage Layout) implements the `DocumentWriter` interface for local files.
- Ticket 022 (Notion Backend) will implement the same interface for Notion pages.

#### Open Questions (Time-boxed or Future)
- **Batch writes**: Should we support `writeMultipleDocuments()` for bulk operations? → **Future ticket (MCP batching optimization).**
- **Soft delete**: Should deleted documents be archived or hard-deleted? → **Future ticket (retention policy).**
- **Content versioning**: Should we store document history? → **Future ticket (audit trail).**
- **Access control**: Should write permissions be enforced at the DocumentWriter level? → **Future ticket (permissions layer, ticket 039).**

#### Validation & Closure
This implementation plan establishes:
- ✅ Stable `DocumentWriter` interface with clear input/output contracts
- ✅ ULID/UUID-based document identity (not title-derived)
- ✅ Immutable `createdAt`, mutable `updatedAt` (standard across all KB tables)
- ✅ Conflict behavior explicitly defined (default deny, explicit override)
- ✅ Error responses unambiguous (400/409/500 with field-specific messages)
- ✅ Client responsibility clarified (agent decides when to override, handles conflicts)
- ✅ Extension points clear (storage backends can be swapped; Notion adapter will use same interface)

**Ticket 002 is now closed.**
