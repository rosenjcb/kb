# Define environment loading policy

## Ticket ID
006

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
001

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### Environment Loading Policy (Startup-Time Validation)

#### Background
The KB agent harness requires configuration (LLM API keys, endpoints, storage paths, feature flags) to run. This configuration should be loaded once at startup, validated against a schema, and made available to all modules via a singleton. This ensures predictable behavior, fast failure on misconfiguration, and clear audit trail of what config was actually used.

#### Approach
Use standard TypeScript environment loading patterns: read configuration at startup from sources (process.env, `.env.local` file), validate with Zod schema, fail fast on missing required values, cache in singleton config object. Follow precedence order: CLI arguments > environment variables > `.env.local` file > defaults.

#### Examples / Specifications

**Environment Variables (Current Stage)**

```bash
# .env.local (git-ignored, local development only)

# ─── LLM Provider Configuration ───
OPENAI_API_KEY=your_key                   # or ANTHROPIC_API_KEY / GEMINI_API_KEY
ANTHROPIC_API_KEY=sk-ant-...              # Only if provider=anthropic
OPENAI_API_KEY=sk-...                     # Only if provider=openai
GEMINI_API_KEY=...                        # Only if provider=gemini
OLLAMA_ENDPOINT=http://localhost:11434    # Default for ollama

# ─── KB Storage ───
KB_BASE_DIR=./kb-local                    # Where to store markdown files

# ─── Agent Loop Tuning ───
MAX_AGENT_TURNS=10                        # Default 10
AGENT_TIMEOUT_MS=300000                   # 5 minutes total

# ─── Observability ───
LOG_LEVEL=info                            # or debug, warn, error

# ─── Feature Flags (Future) ───
ENABLE_SEMANTIC_SEARCH=false              # Vector embeddings (v1.1)
ENABLE_NOTION_BACKEND=false               # Notion integration (v1.2)
```

**Configuration Schema (Zod)**

```typescript
import { z } from 'zod'

const ConfigSchema = z.object({
  // LLM Provider (required)
  llmProvider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
  
  // API Keys (conditioned on provider)
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  ollamaEndpoint: z.string().url().optional().default('http://localhost:11434'),
  
  // KB Storage
  kbBaseDir: z.string().default('./kb-local'),
  
  // Agent Loop Tuning
  maxAgentTurns: z.number().int().min(1).default(10),
  agentTimeoutMs: z.number().int().min(1000).default(300000),
  
  // Observability
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Feature Flags
  enableSemanticSearch: z.boolean().default(false),
  enableNotionBackend: z.boolean().default(false),
  
  // Metadata
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  nodeEnv: z.enum(['development', 'production', 'test']).optional(),
})

type Config = z.infer<typeof ConfigSchema>
```

**Loading Logic (at Startup)**

```typescript
import { config } from 'dotenv'

// 1. Load .env.local into process.env (overrides not applied; env vars take precedence)
config({ path: '.env.local' })

// 2. Parse and validate
function loadConfig(): Config {
  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    ollamaEndpoint: process.env.OLLAMA_ENDPOINT,
    kbBaseDir: process.env.KB_BASE_DIR,
    maxAgentTurns: process.env.MAX_AGENT_TURNS ? parseInt(process.env.MAX_AGENT_TURNS, 10) : undefined,
    agentTimeoutMs: process.env.AGENT_TIMEOUT_MS ? parseInt(process.env.AGENT_TIMEOUT_MS, 10) : undefined,
    logLevel: process.env.LOG_LEVEL,
    enableSemanticSearch: process.env.ENABLE_SEMANTIC_SEARCH === 'true',
    enableNotionBackend: process.env.ENABLE_NOTION_BACKEND === 'true',
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  }

  // 3. Apply provider-specific validation
  if (raw.llmProvider === 'anthropic' && !raw.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when using Anthropic')
  }
  if (raw.llmProvider === 'openai' && !raw.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when using OpenAI')
  }
  if (raw.llmProvider === 'gemini' && !raw.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required when using Gemini')
  }

  // 4. Validate schema
  const parsed = ConfigSchema.parse(raw)
  return parsed
}

// 5. Create singleton
let configInstance: Config | null = null

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig()
  }
  return configInstance
}

// 6. Call at app startup
try {
  const config = getConfig()
  console.log(`✓ Config loaded: provider auto-selected, LOG_LEVEL=${config.logLevel}`)
} catch (error) {
  console.error('✗ Config validation failed:', error.message)
  process.exit(1)  // Fail fast
}
```

**Precedence Order**

```
1. Process environment variables (process.env)
   - Set via CLI: OPENAI_API_KEY=your_key node src/cli/index.ts
   - Set in shell: export OPENAI_API_KEY=...; npm run start
2. .env.local file (if present)
   - Loaded via dotenv.config({ path: '.env.local' })
   - Gitignored; safe for local development
   - Does NOT override already-set process.env
3. Defaults from schema
   - LOG_LEVEL defaults to 'info'
   - OLLAMA_ENDPOINT defaults to http://localhost:11434
4. No fallback → Error
   - Provider is inferred from available API keys; explicit provider env is not required
   - API key for chosen provider is required
```

**Example Loading Sequence**

```typescript
// Shell setup
$ export ANTHROPIC_API_KEY=your_key
$ export ANTHROPIC_API_KEY=sk-ant-abc123def456
$ npm run dev

// app.ts startup
// 1. dotenv loads .env.local → finds provider-specific API keys (already in process.env, no override)
// 2. Schema validation:
//    - llmProvider: 'anthropic' ✓
//    - anthropicApiKey: 'sk-ant-...' ✓
//    - kbBaseDir: defaults to './kb-local' ✓
//    - maxAgentTurns: defaults to 10 ✓
// 3. getConfig() returns validated Config object
// 4. All modules import { getConfig } from './config' and use it
```

**Config Validation Results**

| Scenario | Behavior | Exit Code |
|----------|----------|-----------|
| All required vars set | Load success, use config | 0 |
| No provider-specific API keys | Fallback to local Ollama endpoint | 0/connection-dependent |
| Anthropic selected by key but no valid key | Provider client fails to initialize | 1 |
| OpenAI selected by key but no valid key | Provider client fails to initialize | 1 |
| MAX_AGENT_TURNS not a number | Error: "maxAgentTurns must be an integer" | 1 |
| All optional flags omitted | Use defaults; no error | 0 |

#### Multi-Environment Support (Future Roadmap)

**Current (v1.0):**
- `.env.local` — Local development

**Future (v1.1+):**
```bash
.env.local        # Developer overrides (gitignored)
.env.development  # Development server config (committed)
.env.staging      # Staging server config (committed)
.env.production   # Production config (NOT committed; loaded via CICD)
```

**Loading logic (future):**
```typescript
const envFile = `.env.${process.env.NODE_ENV || 'development'}`
config({ path: envFile })  // Load environment-specific file
```

**CICD Injection (future):**
```dockerfile
# Dockerfile
ENV ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}  # Injected at build time
ENV OPENAI_API_KEY=your_key
ENV ENVIRONMENT=production
```

#### Security & Redaction (Future Work)

**TODO:** API keys should be:
- ✅ Not logged in debug output
- ✅ Not stored in version control
- ✅ Validated for format (e.g., "sk-" prefix for OpenAI)
- ✅ Rotated periodically

**For now:** See ticket [FUTURE: Security hardening] for implementation.

#### Integration Points

- **Ticket 037**: Provider selection policy uses config.llmProvider
- **Ticket 001**: KB base directory from config.kbBaseDir
- **Ticket 044-045**: Observability uses config.logLevel
- **All MCP tools**: Access config via getConfig() singleton

#### Decisions Made

- ✅ **Load at startup**: Singleton config object, fail fast on validation error
- ✅ **Schema validation**: Zod for type-safe config with provider-specific rules
- ✅ **Precedence**: CLI env > process.env > .env.local > defaults
- ✅ **Credential-driven defaults**: provider inferred from available credentials
- ✅ **Gitignore `.env.local`**: Safe for local development secrets
- ✅ **Fail fast**: Exit(1) immediately on config error; don't defer
- ✅ **Future-proof**: Support `.env.dev`, `.env.prod` later via NODE_ENV

#### Open Questions (Time-boxed or Future)

- **Environment-specific defaults**: Should different environments have different defaults (e.g., logLevel=debug in dev, logLevel=error in prod)? → **Future ticket (environment-specific configs).**
- **Config hot-reload**: Should config be re-loadable at runtime? → **Defer: Current policy is startup-time only.**
- **Config override file**: Should there be a `config.json` or `config.toml` option in addition to env vars? → **Future ticket (config file format support).**
- **Secrets management**: Should we integrate with external secret manager (AWS Secrets Manager, Vault)? → **Future ticket (ticket: Secrets management integration).**

#### Validation & Closure

This implementation plan establishes:
- ✅ Startup-time loading via dotenv from `.env.local`
- ✅ Zod schema validation with provider-specific rules
- ✅ Singleton config pattern for consistent access
- ✅ Fail-fast on validation errors (exit 1)
- ✅ Clear precedence: CLI > env > .env.local > defaults
- ✅ Multi-environment roadmap (dev/staging/prod for future)
- ✅ Security hardening deferred to future ticket
- ✅ Integration points identified

**Ticket 006 is now closed.**
