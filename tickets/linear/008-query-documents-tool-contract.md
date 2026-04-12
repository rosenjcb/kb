# Query/Read Documents Tool Contract

## Ticket ID
008

## Theme
local-kb

## Problem
Agent needs to retrieve documents from KB. Must support flexible querying: by exact ID, title prefix, and tags. Must return either list of matching documents or full document body.

## Scope
- Define query input/output shapes
- Specify search behavior (exact vs prefix, tag filtering)
- Define error conditions
- Add concrete examples

## Acceptance Criteria
- Query contract is unambiguous
- Search behavior clearly specified
- Error conditions documented
- Integration with DocumentWriter clear

## Dependencies
002,007

## Deliverables
- Tool contract TypeScript interface
- Query examples and expected results
- Error taxonomy

## Estimate
S

## Priority
TBD

---

## Implementation Plan

### Query Documents Tool Contract

#### Background
Complement to DocumentWriter (Ticket 002). Agents need to read/search documents by ID, title prefix, or tags. Must return structured results suitable for agent decision-making and MCP serialization.

#### Approach
Define minimal QueryDocuments interface with flexible search input. Support three modes: exact ID lookup (fast), title prefix search, and tag filtering. Return either full document body or metadata list depending on input.

#### Examples / Specifications

**Type Definitions:**

```typescript
interface QueryDocumentsInput {
  query?: string                    // Search term: ID, title prefix, or tag
  mode?: 'id' | 'title' | 'tags'   // Default: 'title' (try all)
  tags?: string[]                  // Filter results to only these tags
  limit?: number                   // Max results (default 10)
  includeContent?: boolean         // Include full document body (default false)
}

interface DocumentMetadata {
  id: string
  title: string
  filePath: string
  createdAt: string
  updatedAt: string
  tags?: string[]
}

interface QueryResult {
  metadata: DocumentMetadata      // For includeContent=false
}

interface QueryResultWithContent extends QueryResult {
  content: string                 // For includeContent=true
}

interface QueryResponse {
  results: (QueryResult | QueryResultWithContent)[]
  total: number
  query: string
  mode: string
}

interface DocumentReader {
  queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse>
}
```

**Query Examples:**

**Example 1: Search by exact ID**
```json
{
  "query": "auth-decision",
  "mode": "id",
  "includeContent": true
}
```

Response:
```json
{
  "results": [
    {
      "metadata": {
        "id": "auth-decision",
        "title": "Authentication Architecture Decision",
        "filePath": "kb/sessions/documents/auth-decision.md",
        "createdAt": "2026-04-12T14:35:22Z",
        "updatedAt": "2026-04-12T14:35:22Z",
        "tags": ["architecture", "decision", "security"]
      },
      "content": "# Authentication Architecture Decision\n\n..."
    }
  ],
  "total": 1,
  "query": "auth-decision",
  "mode": "id"
}
```

**Example 2: Search by title prefix**
```json
{
  "query": "auth",
  "mode": "title",
  "limit": 5,
  "includeContent": false
}
```

Response:
```json
{
  "results": [
    {
      "metadata": {
        "id": "auth-decision",
        "title": "Authentication Architecture Decision",
        "filePath": "kb/sessions/documents/auth-decision.md",
        "createdAt": "2026-04-12T14:35:22Z",
        "updatedAt": "2026-04-12T14:35:22Z",
        "tags": ["architecture", "decision"]
      }
    },
    {
      "metadata": {
        "id": "auth-migration-plan",
        "title": "Authentication Migration Plan (JWT)",
        "filePath": "kb/sessions/documents/auth-migration-plan.md",
        "createdAt": "2026-04-12T14:36:00Z",
        "updatedAt": "2026-04-12T14:36:00Z",
        "tags": ["implementation", "migration"]
      }
    }
  ],
  "total": 2,
  "query": "auth",
  "mode": "title"
}
```

**Example 3: Filter by tags**
```json
{
  "tags": ["architecture", "decision"],
  "includeContent": false
}
```

Response:
```json
{
  "results": [
    {
      "metadata": {
        "id": "auth-decision",
        "title": "Authentication Architecture Decision",
        "tags": ["architecture", "decision", "security"]
      }
    },
    {
      "metadata": {
        "id": "error-handling",
        "title": "Error Handling Policy",
        "tags": ["architecture", "decision", "reliability"]
      }
    }
  ],
  "total": 2,
  "query": "tags: architecture, decision",
  "mode": "tags"
}
```

**Search Behavior**

| Mode | Behavior | Example |
|------|----------|---------|
| `id` | Exact match on document ID | `query="auth-decision"` → returns exactly 1 doc (or not found) |
| `title` | Case-insensitive prefix match on title | `query="auth"` → returns `auth-decision`, `auth-migration-plan`, etc. |
| `tags` | Exact match on ALL provided tags (AND logic) | `tags=["arch", "decision"]` → only docs with both tags |
| default (no mode) | Try ID first, then title prefix, then tags | Works like user didn't know what to search for |

**Auto-Mode (when mode not specified):**

```typescript
async function queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
  if (!input.mode && input.query) {
    // Try in order: exact ID → title prefix
    let results = lookupById(input.query)
    if (results.length === 0) {
      results = lookupByTitlePrefix(input.query)
    }
    return results
  }
  
  if (input.tags?.length) {
    return filterByTags(input.tags, input.limit)
  }
  
  // Fallback: empty query returns recent documents
  return getRecentDocuments(input.limit ?? 10)
}
```

#### Error Conditions

| Condition | Response |
|-----------|----------|
| No query, no tags, mode not specified | Return 10 most recent docs |
| Query with mode='id' not found | Return empty results (not an error) |
| Query with mode='title' no matches | Return empty results |
| Tags filter returns zero docs | Return empty results |
| Invalid query format | 400 error (let agent fix) |
| KB base directory not found | 500 error (system error) |

#### Integration Points

- **Ticket 002**: Complements DocumentWriter; both implement storage interface
- **Ticket 007**: Reads from markdown storage + index table
- **Ticket 018-019**: MCP tools will use this contract for `read_documents` tool
- **Agent loop**: Agent can call read_documents tool to retrieve context

#### Decisions Made

- ✅ **Three search modes**: ID (fast), title (common), tags (filtering)
- ✅ **Auto-mode**: Try ID first, fall back to title (convenience for agent)
- ✅ **Tag filtering**: AND logic (all tags must match)
- ✅ **Content optional**: By default return metadata only (fast); opt-in for full body
- ✅ **Result limit**: Configurable, default 10
- ✅ **Empty results as success**: Don't error on zero matches (agent handles)

#### Open Questions (Time-boxed or Future)

- **Full-text search**: Should we search document content, not just title/tags? → **Future (v1.1, content indexing).**
- **Fuzzy matching**: Should "authentication" match "auth"? → **Future (full-text search, v1.1).**
- **Pagination**: Should results be paginated for large result sets? → **Future (large result handling).**
- **Vector similarity**: Should we rank results by semantic similarity? → **Future (v1.2, embeddings).**

#### Validation & Closure

This implementation plan establishes:
- ✅ Query contract with flexible input (ID, title prefix, tags)
- ✅ Three search modes with clear behavior
- ✅ Auto-mode for convenience (agent doesn't need to specify mode)
- ✅ Content optional (metadata-only by default, fast)
- ✅ Error conditions documented
- ✅ Integration clear (Ticket 018 will wrap this in MCP tool)

**Ticket 008 is now closed.**
