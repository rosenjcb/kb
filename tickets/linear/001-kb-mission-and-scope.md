# Define KB mission and scope

## Ticket ID
001

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
none

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### Mission
The **Knowledge Base (KB)** is a semantic storage and retrieval system that serves as the single source of truth for a coding agent's understanding of a project, user preferences, architectural decisions, and operational constraints. Instead of asking agents to read entire repositories or maintaining brittle context snippets, the KB is queried in natural language via MCP, returning exactly what an agent needs to make decisions.

### Core Users & Interactions
1. **Claude (via MCP)**: Primary consumer. Asks questions like "What are the deployment constraints?" or "Show me the authentication architecture decisions" and receives structured markdown responses.
2. **Other LLM Agents**: Future support for multi-agent workflows; same query interface.
3. **Humans**: Authors and maintainers of KB documents; edit markdown files or provide updates through agents.

### Scope (What We Handle)
- **Store**: Markdown documents representing decisions, permissions, state, architectural patterns, and project metadata.
- **Query**: Natural language search/retrieval via MCP, returning best-matching documents or synthesized answers.
- **Update**: Document creation, modification, deletion through agent tooling (write_document, update_document, delete_document).
- **Index**: Maintain fast lookups through document tables and optional vector embeddings (future).
- **Versioning**: Track document history and audit who/when/why changes occur.

### Scope (What We Explicitly Don't Handle)
- Real-time code execution or testing (agent responsibility).
- Database schema management (out of scope; managed separately).
- Secret/credential storage (use external secret manager).
- Live repository git operations (use git directly; KB stores decisions about how to use git).

### Key Entities & Request/Response Shapes

#### Document Structure
```
Title: string (human-readable)
Id: string (kebab-case slug, auto-generated or provided)
Content: markdown (body of knowledge)
Tags: string[] (searchable metadata: architecture, decision, permission, how-to, etc.)
CreatedAt: timestamp
UpdatedAt: timestamp
Author: string (optional, for audit)
```

#### Query Request (Agent → KB via MCP)
```
Query: string (natural language question or search term)
Tags?: string[] (optional filter: only return docs with these tags)
Limit?: number (max results, default 5)
```

#### Query Response (KB → Agent)
```
Results: Document[] (matched documents, sorted by relevance)
Metadata: {
  totalMatches: number
  queryTime: number (ms)
  strategy: string (e.g., "fulltext", "semantic", "tag-filter")
}
```

#### Write Request (Agent → KB)
```
Title: string (required, non-empty)
Content: string (markdown body)
Tags: string[] (required, non-empty)
Id?: string (optional; if provided, ensures idempotency)
Overwrite?: boolean (replace existing doc with same id)
```

#### Write Response (KB → Agent)
```
Id: string (document identifier)
Title: string
FilePath: string (where document was stored)
CreatedAt: timestamp
UpdatedAt: timestamp
Status: "created" | "updated" | "conflict" (if overwrite=false and doc exists)
```

### Error Conditions
- **Validation Errors**: Missing required fields, invalid tags format, title too short/long → return 400 with field errors.
- **Not Found**: Query returns zero results → return 404 or empty results array with meta.totalMatches=0.
- **Conflict**: Write to existing id with overwrite=false → return 409 with suggested id variant.
- **Permission Denied**: Document tagged as restricted (business-decisions, secrets, etc.) without auth → return 403.
- **Storage Errors**: Disk full, corrupt file → return 500 with fallback to in-memory shadow copy.

### Architecture Sketch
```
MCP Server (this project)
  ├─ Query Handler
  │  ├─ Tokenize query → search index
  │  ├─ Optional: Semantic search (embeddings, future)
  │  └─ Return ranked Document[]
  ├─ Write Handler
  │  ├─ Validate input (Zod schema)
  │  ├─ Generate id (if not provided)
  │  ├─ Check collision (if not overwrite)
  │  └─ Write to storage (markdown files + index)
  └─ Storage Layer
     ├─ MarkdownMDWriterTool (local files, current)
     └─ NotionWriter (future swap)
```

### Initial Implementation Priorities
1. **Query by tag filter**: Agent asks "Show me all architecture decisions" (tag="decision"). Simple substring match on Document.Tags.
2. **Query by title/content**: Agent asks "How do we handle auth?" → full-text search on title/content.
3. **Write (create/update)**: Agent creates new decision doc or updates permissions.
4. **Conflict resolution**: Gracefully handle duplicate document titles; return suggested id variant.
5. **Answer synthesis** (future): KB returns multiple docs + asks agent to synthesize into a single prose answer if needed.

### Open Questions (Time-boxed)
- **Semantic search**: Do we use vector embeddings (e.g., Pinecone) or stick with BM25 full-text for now? → **Decision: Start with full-text. Add embeddings if query latency > 200ms.**
- **Auth/read restrictions**: How do we tag and filter sensitive docs (permissions.yaml, business decisions)? → **Decision: Use "restricted" tag + optional password-protected docs in future.**
- **Sync with repo**: How does KB stay in sync with actual code/config? → **Decision: Agent responsibility to query KB, validate against repo, and report drift. KB is source of truth for intent; repo is source of truth for current state.**

### Open Questions (Future Work)
- Chat history: Should KB store conversation history or just project knowledge? → **Out of scope for v1.**
- Multi-user authoring: How do multiple humans safely edit KB docs? → **Out of scope; single-user for MVP.**
- Approval workflows: Should KB updates require review before agents can see them? → **Out of scope; future governance layer.**

### Validation & Closure
This implementation plan establishes:
- ✅ KB is the semantic intermediary between agents and project context.
- ✅ Request/response shapes are defined and amenable to MCP serialization.
- ✅ Error conditions and fallbacks are explicit.
- ✅ Future extensibility points are clear (semantic search, auth, multi-user).

**Ticket 001 is now closed.**
