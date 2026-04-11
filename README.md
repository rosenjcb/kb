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

## Roadmap

See [GAMEPLAN.md](GAMEPLAN.md) for the full roadmap and phased implementation plan.
