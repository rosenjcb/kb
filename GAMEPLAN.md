# DocSync MCP — Summary

## Current Reality Check (April 2026)

- The repo currently has an agent harness (providers + loop + CLI), not a full MCP server yet.
- The first document tool path is local markdown storage via a writer interface.
- Notion remains the target source of truth once the Notion writer/backend is added.

## What It Is
Target state: a stateless MCP server that keeps your Notion docs in sync with your codebase. Notion is the source of truth. The server reads Notion, compares against real code via Gemini, flags violations, and writes updates back to Notion. The Claude Code agent acts on the results.

Near-term implementation path: start with a local markdown-backed writer and identical tool contracts, then swap in/add a Notion-backed implementation.

## Stack
- **MCP Server** — Node.js / TypeScript, `@modelcontextprotocol/sdk`
- **LLM** — Gemini (`@google/generative-ai`) for code vs. doc reasoning
- **Docs** — Notion API (`@notionhq/client`), free at all tiers, 3 req/sec limit
- **Validation** — Zod on all Gemini outputs (retry layer for malformed JSON)
- **Config** — `docsync.toml`

## Flow
```
Claude Code Agent
  → MCP tool call
  → Read Notion doc + Read code
  → Gemini compares them
  → Violations returned to agent OR doc written back to Notion
```

## Tools

| Tool | What it does |
|---|---|
| `docsync_check` | Check one file against Notion, return violations |
| `docsync_document` | Write or update a Notion page from code |
| `docsync_audit` | Scan a whole directory, return coverage + all violations |

## Violation Types
- `undocumented_export` — symbol in code, no Notion page
- `signature_mismatch` — params/return type differ from docs
- `stale_description` — behavior changed, description hasn't
- `missing_section` — doc page exists but is incomplete

## Build Phases
1. **Phase 0 (Now)** — local writer abstraction + markdown implementation (`DocumentWriter` + `MarkdownMDWriterTool`)
2. **MVP** — `docsync_check` end to end (Notion read + Gemini compare + violations out)
3. **Write layer** — `docsync_document`, Notion create/update
4. **Audit** — `docsync_audit`, directory scan, coverage report
5. **Polish** — rate limit handling, retry logic, config file support

## Key Rules
- Gemini is **not agentic** — it gets a prompt, returns JSON. Your server orchestrates everything.
- The agent **decides** what to do with violations — server only reports.
- Notion API is **free**, just needs an integration key from notion.so/my-integrations with explicit page access.
- Keep tool interfaces backend-agnostic so markdown and Notion implementations can coexist during migration.