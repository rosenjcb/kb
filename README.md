# KB: Knowledge Base For Your Agent

KB is a TypeScript harness for building a knowledge base your agent can read from and write to.

Today it includes a provider-agnostic agent loop and a first document-writing tool that stores markdown documents locally. The direction is to add a Notion-backed implementation and evolve toward a DocSync-style MCP server.

## Mission

- Build a reliable knowledge layer for agents.
- Keep documentation close to real code behavior.
- Make storage backends swappable (local markdown now, Notion next).

## Current Status

- Provider abstraction for Anthropic, OpenAI, Gemini, and Ollama.
- Unified event-driven `agentLoop`.
- CLI runner for quick local testing.
- First tool scaffold: `write_document` with a markdown storage implementation.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run checks
pnpm run check

# Run with environment from .env.local (recommended)
pnpm run dev:local "hello"
```

If you do not use `.env.local`, run with exported environment variables and `pnpm run dev`.

## Project Structure

```text
kb/
├── src/
│   ├── core/    # Agent loop, LLM providers, types
│   ├── tools/   # Tool contracts + implementations (markdown today, Notion later)
│   ├── state/   # Session and decision persistence (in progress)
│   └── cli/     # CLI entrypoint
├── business/
│   ├── decisions.md
│   └── permissions.yaml
├── sessions/
│   └── documents/ # Local markdown docs created by writer tools
└── GAMEPLAN.md
```

## Doc Writer Tool Direction

The first tool is intentionally interface-first:

- `DocumentWriter` interface defines the write contract.
- `MarkdownMDWriterTool` is the initial implementation.
- A future `NotionDocumentWriter` can be added without changing callers.

This keeps the tool layer compatible with a future MCP server where Notion is the source of truth.

## Development

- Lint: `pnpm run lint`
- Format: `pnpm run format`
- Type check: `pnpm run type-check`

### Tool Design

All tools follow **separation of concerns** principle:
- Each tool has exactly one responsibility
- Tool names document intent (e.g., `merge_documents`, not `write_document` with mode parameter)
- See [Tool Design Conventions](src/tools/TOOL_CONVENTIONS.md) for guidelines and examples

This pattern is informed by production code in `claude-code`: FileReadTool vs FileEditTool vs FileWriteTool, not polymorphic FileOperationTool.

## Global CLI Setup

Install `kb` as a global utility from this repository:

```bash
npm run install:global
kb "What tools are available?"
```

Refresh to the latest local code after changes:

```bash
npm run refresh:global
npm run which:kb
```

If global install is unavailable, run the built executable directly:

```bash
npm run build:cli
node dist/bin/kb.js "What tools are available?"
```

## KB Base Selection Strategy

To avoid test data interfering with real documentation, use base selection.

- `kb use <base>`: choose a base alias for the current shell session (prints export guidance).
- `kb default <base>`: persist a preferred base alias for future invocations.
- `KB_BASE=<base>`: environment override for base alias.
- `KB_BASE_DIR=/custom/path`: explicit path override (highest precedence).

Default behavior (when no env override and no saved default exists) uses `sessions/namespaces/default/documents`.

Example (macOS/Linux):

```bash
export KB_BASE=dogfood
kb "Document the latest architecture decision"
```

Example (PowerShell):

```powershell
$env:KB_BASE = "dogfood"
kb "Document the latest architecture decision"
```

You can also use command-based selection:

```bash
kb use dogfood
kb default dogfood
```

## Prevent Data Loss

Dogfood KB content must be committed and pushed to GitHub regularly.

Recommended backup loop:

```bash
# 1) Work in persistent base
export KB_BASE=dogfood

# 2) Use kb normally
kb "Capture today's implementation notes"

# 3) Commit KB changes
git add sessions/
git commit -m "kb: checkpoint knowledge base"

# 4) Push off machine
git push
```

Notes:

- `.gitignore` excludes `sessions/namespaces/ci-*` and `sessions/namespaces/test-*` only.
- Persistent KB docs are intended to be versioned in Git.
- If storage backend changes later (for example SQLite or Notion), keep the same checkpoint habit for any local artifacts until remote persistence is fully in place.

## Roadmap

See [GAMEPLAN.md](GAMEPLAN.md) for the full roadmap and phased implementation plan.
