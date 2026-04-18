---
layout: default
title: Knowledge Graph
nav_order: 20
---

# Knowledge Graph

KB maintains a property graph alongside its document store. While the SQLite index gives you keyword and semantic retrieval, the graph gives you a structural view of how ideas connect — relationships that a flat text index cannot express.

---

## What it does

**Navigation** — ask "what does X depend on?" or "what implements Y?" by entity name. No query language needed.

**Path finding** — "How is A related to B?" runs a shortest-path traversal over the graph, surfacing non-obvious connections across documents (up to 6 hops).

**Query expansion** — when you run `kb query` or `kb chat`, the graph is consulted first. Neighbors of your query terms are added as synonyms before hitting the document index, improving recall when your phrasing differs from how facts were originally written.

**Export** — dump the full graph as Graphviz DOT (for Gephi or Mermaid) or JSON for your own analysis.

---

## Storage

The graph lives at `~/.kb/sessions/<base>/.kb-graph.duckdb` — a [DuckDB](https://duckdb.org) file next to the SQLite document index.

Schema:

```sql
entities      — id, name, type, doc_id, created_at
relationships — id, from_id, to_id, type, doc_id, weight, created_at
```

**Entity types:** `concept`, `system`, `tool`, `decision`, `person`

**Relationship types:** `depends_on`, `contradicts`, `related_to`, `replaces`, `implements`, `uses`

**`weight`:** `1.0` for live edges; `0` for soft-deleted edges (set by `kb invalidate`). Soft deletion preserves history while removing edges from live traversals.

KB uses [DuckPGQ](https://duckdb.org/2023/04/18/graph.html) property graph queries when available, falling back to recursive CTEs otherwise.

---

## How it stays up to date

| Trigger | What happens |
|---|---|
| `kb submit "<fact>"` | LLM extracts entities + relationships from the fact text; upserted synchronously |
| `kb invalidate "<old>"` | All edges whose `doc_id` matches affected documents are soft-deleted (`weight → 0`) |
| `kb init` — `pass-graph` cycle | LLM runs batch extraction over all finalized documents after init completes |

Graph extraction uses an LLM to identify entities and typed relationships in each piece of text. The extractor outputs structured JSON — entity IDs, names, types, and relationship triples — which are upserted into DuckDB.

---

## Graph-augmented query

Every `kb query` and `kb chat` call goes through this expansion pipeline before hitting the document index:

1. Query terms are slugified and looked up as entity IDs in the graph.
2. Direct neighbors (outgoing + incoming, depth 1) are added as expansion terms.
3. The expanded term set is used alongside the original query in full-text and hybrid retrieval.

This means a query for `"DuckGraphWriter"` will also surface documents mentioning `"DuckDB"` or `"property graph"` if those edges exist — even if those exact terms don't appear in your query.

---

## CLI

```bash
# Summary: entity count, relationship count, top nodes by connections
kb graph

# All outgoing + incoming edges for a named entity
kb graph --entity "auth-service"

# Shortest path between two entities (max 6 hops)
kb graph --path "frontend" "postgres"

# Export as Graphviz DOT (pipe to dot, Gephi, or Mermaid)
kb graph --format dot > graph.dot

# Export full graph as JSON
kb graph --format json > graph.json
```

---

## Configuration

Graph mode is **enabled by default**. To disable graph extraction and graph-augmented lookup:

```bash
# Persistent — writes to ~/.kb/config.json
kb config set graph.enabled false

# One-off override
KB_GRAPH=false kb query "topic"
```

---

## Implementation

| File | Role |
|---|---|
| `src/tools/duck-graph-writer.ts` | DuckDB schema, upsert, soft-delete, traversal, export |
| `src/tools/graph-entity-extractor.ts` | LLM-based entity + relationship extraction |
| `src/prompts/graph-extraction.md` | Extraction system prompt |
| `src/cli/graph-cli.ts` | `kb graph` command output formatting |
| `src/cli/init-cli.ts` | `pass-graph` cycle in `kb init` |
