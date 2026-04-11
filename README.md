# KB - Agent Harness

TypeScript-based LLM agent harness with provider-agnostic design.

## Features

- 🤖 **Provider Abstraction**: Works with Claude, GPT, Gemini, Ollama, or any LLM
- 🎯 **Business-First Config**: Tool permissions and rules in YAML
- 📊 **Decision Audit Trail**: Every permission tracked and logged
- 🔄 **Event Streaming**: Real-time async generator for UI integration
- 🛡️ **Type-Safe**: Full TypeScript with Zod validation
- 📝 **Self-Documented**: Biome linting + Zod schemas as docs

## Quick Start

```bash
# Install dependencies
pnpm install

# Check code
pnpm run check

# Run dev mode
pnpm run dev
```

## Project Structure

```
kb/
├── src/
│   ├── core/           # Agent loop, LLM providers, types
│   ├── tools/          # Tool definitions and executor
│   ├── state/          # Session persistence, decisions log
│   └── cli/            # CLI interface
├── business/           # Business rules and decisions
│   ├── decisions.md    # Strategic decisions
│   └── permissions.yaml # Role-based access control
└── sessions/           # Persisted conversations
```

## Configuration

### Add LLM Provider

In code:
```typescript
import { createProvider } from '@core/llm-provider'

const provider = createProvider({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-3-5-sonnet-20241022'
})
```

### Define Tools

Add to `business/tools.yaml`:
```yaml
tools:
  my_tool:
    description: "What this does"
    permissions:
      - role: admin
        allowed: true
      - role: analyst
        denied_patterns:
          - "restrict_this_*"
```

## Development

- **Linting**: `pnpm run lint` (Biome enforced)
- **Format**: `pnpm run format` (auto-fix code style)
- **Type Check**: `pnpm run type-check` (catch errors)
- **Watch**: Use `bun --watch src/cli/index.ts` for development

## Tech Stack

- **Runtime**: Bun or Node 20+
- **Language**: TypeScript 5.5
- **LLM Integration**: Provider pattern (extensible)
- **Validation**: Zod schemas
- **Config**: YAML for business rules
- **Linting**: Biome (strict enforcement)
- **Package Manager**: pnpm

## Next Steps

1. Implement tool executor in `src/tools/executor.ts`
2. Add session persistence in `src/state/session.ts`
3. Create CLI commands in `src/cli/`
4. Connect to your LLM provider
