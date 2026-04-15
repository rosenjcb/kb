# KB

KB is a local-first knowledge system for AI workflows.

It gives you a CLI and runtime that can:
- store durable markdown knowledge,
- query that knowledge through intent commands,
- optionally use SQLite hybrid retrieval (FTS + vector-style ranking) for better search quality as your corpus grows.

## Generalized Use Case

Use KB when you want a repeatable way to capture, validate, dispute, and retrieve project knowledge during development.

Typical flow:
1. Record facts and decisions while you work.
2. Query prior context before making new changes.
3. Keep docs close to code and version them in Git.

## Quick Start

### 1) Install and verify

```bash
pnpm install
pnpm run check
npm run refresh:global
npm run which:kb
```

### 2) Configure `.env.local` (recommended)

Create `.env.local` at the repository root and keep runtime settings there.

Example:

```bash
cat > .env.local <<'EOF'
OPENAI_API_KEY=your_key
EOF
```

Provider selection is automatic from available credentials in this order: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, then local `OLLAMA_ENDPOINT`.

Use local-env commands when you want explicit `.env.local` context:

```bash
pnpm run dev:local "What tools are available?"
pnpm run start:local "hello"
```

### 3) Select your KB base

```bash
kb use dogfood
kb default dogfood
kb use --show
```

Precedence order:
1. `kb use` session base
2. `kb default` saved default

### 4) Start using intent commands

```bash
kb submit "Document writer now supports sqlite index sync" --source implementation
kb query "sqlite index sync behavior" --limit 5 --output human
kb validate "kb default persists the active base"
kb dispute "kb use should persist across sessions" --because "Only kb default should change durable base config"
```

## Optional: SQLite Hybrid Search

Enable this when your knowledge corpus gets larger and semantic retrieval quality matters.

### 1) Enable native SQLite dependency (if needed)

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

### 2) Turn on indexing and hybrid query in `.env.local`

```bash
cat >> .env.local <<'EOF'
KB_SQLITE_INDEX=true
KB_HYBRID_QUERY=true
EOF
```

Optional tuning:

```bash
cat >> .env.local <<'EOF'
KB_HYBRID_QUERY_CANDIDATES=40
KB_HYBRID_QUERY_ALPHA=0.45
KB_HYBRID_QUERY_MAX_MS=120
EOF
```

### 3) Verify

```bash
kb submit "SQLite hybrid search enabled for this workspace" --source setup
kb query "hybrid sqlite retrieval" --limit 5 --output human
```

If hybrid retrieval is unavailable or exceeds latency budget, KB automatically falls back to lexical markdown query.

## Daily Workflow

```bash
# work
kb query "topic"
kb submit "new fact" --target <doc-id>

# checkpoint durable docs
git add sessions/
git commit -m "kb: checkpoint knowledge base"
git push
```

## Development Commands

```bash
pnpm run test
pnpm run type-check
pnpm run lint
pnpm run build
```

## Project Map

```text
src/core   - provider abstraction, agent loop, runtime types
src/cli    - CLI entrypoint, intent command parsing, base selection
src/tools  - write/query tools, markdown + sqlite index integration
sessions/  - persisted knowledge documents by namespace
tickets/   - planning/spec workflow
```
