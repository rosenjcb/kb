# Knowledge Graph

KB maintains a property graph alongside its SQLite document store. The graph tracks concepts, systems, tools, decisions, and people as **entities**, connected by typed **relationships** (e.g. `uses`, `depends_on`, `implements`).

## What it does for you

As you build up your knowledge base, the graph gives you a structural view of how ideas connect — something the flat SQLite full-text index cannot express.

**Navigation:** You can ask "what does X depend on?" or "what implements Y?" by name, without writing a query.

**Path finding:** "How is A related to B?" runs a shortest-path traversal over the graph, surfacing non-obvious connections across documents.

**Query expansion:** Graph neighbors of a query term are added as synonyms before hitting the document index, improving recall when exact phrasing differs between a query and a stored fact.

**Export:** The full graph can be dumped as Graphviz DOT (for visualisation tools like Gephi or Mermaid) or JSON (for your own analysis).

## Storage

The graph lives at `<base-dir>/.kb-graph.duckdb` — a DuckDB database file next to the SQLite document index.

Graph mode is enabled by default. You can disable graph extraction and graph-augmented lookup with either:

- `graph.enabled: false` in `~/.kb/config.json`
- `KB_GRAPH=false` as a one-off environment override

Schema:

```sql
entities       — id, name, type, doc_id, created_at
relationships  — id, from_id, to_id, type, doc_id, weight, created_at
```

- `type` on entities: `concept | system | tool | decision | person`
- `type` on relationships: `depends_on | contradicts | related_to | replaces | implements | uses`
- `weight`: 1.0 for live edges, 0 for soft-deleted edges (set by `kb invalidate`)
- DuckPGQ property graph (`kb_graph`) is created on open when the extension is available; recursive CTEs handle traversal as a fallback.

## How it stays up to date

| Trigger | What happens |
|---|---|
| `kb submit "<fact>"` | LLM extracts entities + relationships from the fact text; upserted synchronously |
| `kb invalidate "<old>"` | All edges whose `doc_id` matches the affected documents are soft-deleted (weight → 0) |
| `kb init` — `pass-graph` cycle | LLM runs batch extraction over all finalized documents written to SQLite |

## CLI

```
kb graph                          # Summary: entity count, relationship count, top nodes by connections
kb graph --entity <name>          # Outgoing + incoming edges for a named entity
kb graph --path <from> <to>       # Shortest path between two entities (max 6 hops)
kb graph --format dot             # Export as Graphviz DOT to stdout
kb graph --format json            # Export full graph as JSON to stdout
```

## Graph-augmented query

When a graph-enabled lookup runs (`kb query` and `kb chat`), the graph is consulted before the document index:

1. The query terms are slugified and looked up as entity IDs.
2. Direct neighbors (outgoing + incoming, depth 1) are added as expansion terms.
3. The expanded term set is used alongside the original query in full-text and hybrid retrieval.

This means a query for "DuckGraphWriter" will also surface documents mentioning "DuckDB" or "property graph" if those edges exist in the graph — even if those terms don't appear literally in the query.

## Implementation

| File | Role |
|---|---|
| `src/tools/duck-graph-writer.ts` | DuckDB schema, upsert, soft-delete, traversal, export |
| `src/tools/graph-entity-extractor.ts` | LLM-based entity + relationship extraction from text |
| `src/cli/graph-cli.ts` | `kb graph` command parsing and output formatting |
| `src/cli/index.ts` | Wires graph extraction into `submit_fact` and `invalidate` |
| `src/cli/init-cli.ts` | `pass-graph` cycle in `kb init` |
