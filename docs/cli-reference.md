---
layout: default
title: CLI Reference
---

# CLI Reference

All KB commands follow the pattern `kb <command> [args] [flags]`. Running `kb` with no arguments and a TTY launches the [interactive shell](tui). Every command also accepts `--help`.

---

## Intent Commands

Intent commands are the core of KB. They map your natural-language intent to a retrieval or mutation operation against the knowledge base.

### `kb query`

Retrieve documents relevant to a topic.

```bash
kb query "<topic>" [flags]
```

| Flag | Default | Description |
|---|---|---|
| `--limit <n>` | 5 | Maximum number of documents to return |
| `--type <type>` | — | Filter by document type (`architecture`, `decision`, `reference`, `runbook`, `checklist`) |
| `--discovery shallow\|deep` | shallow | Search depth — `deep` expands the query further |
| `--output human\|json` | human | Output format |

**Example:**

```bash
kb query "authentication token expiry" --limit 3
kb query "database schema" --type decision --output json
```

---

### `kb submit`

Record a new fact in the knowledge base.

```bash
kb submit "<fact>" [flags]
```

| Flag | Description |
|---|---|
| `--domain <domain>` | Tag the fact with a domain (e.g. `ops`, `security`) |
| `--source <source>` | Attribute the fact to a source document or runbook |
| `--target <doc-id>` | Append to or update an existing document instead of creating a new one |
| `--output human\|json` | Output format |

**Example:**

```bash
kb submit "Redis cache TTL is 5 minutes for session keys"
kb submit "Switched from MD5 to bcrypt in commit a3f9" --domain security --target auth-hashing
```

---

### `kb validate`

Check whether a claim is supported by KB evidence.

```bash
kb validate "<fact>" [flags]
```

Returns `SUPPORTED`, `NOT_SUPPORTED`, or `UNCERTAIN`, with a one-sentence explanation and a confidence score.

| Flag | Description |
|---|---|
| `--domain <domain>` | Scope validation to a specific domain |
| `--output human\|json` | Output format |

**Example:**

```bash
kb validate "the queue consumer retries failed jobs up to 3 times"
```

If the initial pass is inconclusive (confidence ~0.45), KB automatically runs a deeper LLM reasoning pass before returning.

---

### `kb dispute`

Record a counter-claim against an existing fact.

```bash
kb dispute "<fact>" --because "<counter evidence>" [flags]
```

| Flag | Description |
|---|---|
| `--because <reason>` | **(required)** The counter-evidence or reason for the dispute |
| `--domain <domain>` | Tag the dispute with a domain |
| `--output human\|json` | Output format |

**Example:**

```bash
kb dispute "emails are sent synchronously" --because "email dispatch was moved to a background job in PR #412"
```

---

### `kb explain`

Explain a change or look up the rationale behind a fact.

```bash
kb explain "<change id or fact>" [flags]
```

| Flag | Description |
|---|---|
| `--output human\|json` | Output format |

---

## Knowledge Base Initialization

### `kb init`

Bootstrap a knowledge base from your project's existing documentation.

```bash
kb init [flags]
```

`kb init` runs a 7-cycle pipeline:

1. **read-inputs** — discovers README, CLAUDE.md, and other source files; runs an interview
2. **pass1** — LLM drafts 5–15 candidate documents
3. **pass2** — coverage gap analysis and LLM refinement
4. **pass-enrich** — each document gets an independent LLM enrichment pass
5. **pass-consolidate** — overlapping documents are merged (currently disabled)
6. **pass3** — final quality pass
7. **write** — documents are upserted into SQLite

| Flag | Description |
|---|---|
| `--base <name>` | Knowledge base to initialize (default: active base) |
| `--non-interactive` | Skip the interview; use source files only |
| `--resume` | Resume an interrupted init from the last checkpoint |
| `--detach` | Run init in the background |
| `--stop-after <cycle>` | Halt after a specific cycle (e.g. `--stop-after pass1`) |

---

## Document Browsing

### `kb docs list`

```bash
kb docs list [--base <name>] [--limit <n>] [--output human|json]
```

### `kb docs view`

```bash
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

---

## Base Management

### `kb use`

Switch the active knowledge base.

```bash
kb use <base>             # use for this session
kb use --default <base>   # persist as the default
kb use --show             # print active base and config default
```

Base resolution order:
1. `activeBase` — set by `kb use <base>` for the current session
2. `selectedBase` — persistent default set by `kb use --default <base>`

Base data lives under `~/.kb/sessions/<base>/`.

---

## Configuration

### `kb config`

Read and write KB configuration at `~/.kb/config.json`.

```bash
kb config get                    # print all config values
kb config set <key> <value>      # set a value
kb config unset <key>            # remove a value
```

**Common keys:**

| Key | Description |
|---|---|
| `llm.provider` | `anthropic` or `openai` |
| `selectedBase` | Persistent default base name |
| `graph.enabled` | `true` / `false` — enable/disable the knowledge graph |

---

## Knowledge Graph

### `kb graph`

```bash
kb graph                          # Summary: entity count, relationship count, top nodes
kb graph --entity <name>          # Edges for a named entity
kb graph --path <from> <to>       # Shortest path between two entities (max 6 hops)
kb graph --format dot             # Export as Graphviz DOT
kb graph --format json            # Export full graph as JSON
```

See [Knowledge Graph](knowledge-graph) for details.

---

## Maintenance

### `kb invalidate`

Remove or replace an outdated fact.

```bash
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply]
```

`--preview` shows what would change without applying it. `--apply` commits the changes.

### `kb publish`

Publish KB documents to an external target.

```bash
kb publish [options]
```

---

## Chat

### `kb chat`

Start a multi-turn conversation backed by KB retrieval.

```bash
kb chat
```

Each message retrieves relevant documents and feeds them to an LLM for synthesis. Conversation history accumulates across turns. Type `/exit` to quit.

---

## Output Formats

Most commands support `--output human` (default, colored prose) and `--output json` (machine-readable, suitable for piping). JSON output includes the full result envelope with confidence scores and document IDs.
