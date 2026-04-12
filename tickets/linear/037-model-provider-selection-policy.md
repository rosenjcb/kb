# Define model provider selection policy

## Ticket ID
037

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
005,006

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### Model Provider Selection Policy (V1: Single Model)

#### Background
The KB agent harness supports multiple LLM providers (Anthropic, OpenAI, Gemini, Ollama). We need a stable policy for selecting which provider and model to use at runtime. V1 is simple: one model for all tasks. Future versions will support context-aware selection (big models for planning, simpler models for coding).

#### Approach
Define provider selection at startup via environment config (Ticket 006). One provider + model active per KB instance. Model selection is deterministic and logged. Future ticket will enable dynamic switching based on task context.

#### Examples / Specifications

**Model Selection Hierarchy (V1)**

```typescript
// Load at startup via config (Ticket 006)
type SupportedProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama'

interface ModelConfig {
  provider: SupportedProvider
  model: string                  // e.g., 'claude-3-5-sonnet-20241022'
  maxTokens: number              // e.g., 4096
  temperature: number            // e.g., 0.7
}

// Default models per provider (sensible defaults)
const DEFAULT_MODELS: Record<SupportedProvider, ModelConfig> = {
  anthropic: {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',  // Latest stable Sonnet
    maxTokens: 4096,
    temperature: 0.7,
  },
  openai: {
    provider: 'openai',
    model: 'gpt-4-turbo',                 // Capable reasoning model
    maxTokens: 4096,
    temperature: 0.7,
  },
  gemini: {
    provider: 'gemini',
    model: 'gemini-2.0-flash',            // Fast and capable
    maxTokens: 4096,
    temperature: 0.7,
  },
  ollama: {
    provider: 'ollama',
    model: 'mistral',                     // Lightweight local model
    maxTokens: 2048,
    temperature: 0.7,
  },
}

// Selection logic
function selectModel(provider: SupportedProvider, overrideModel?: string): ModelConfig {
  const base = DEFAULT_MODELS[provider]
  
  if (overrideModel) {
    return {
      ...base,
      model: overrideModel,
    }
  }
  
  return base
}

// Usage in KB harness
const config = getConfig()  // From Ticket 006
const modelConfig = selectModel(config.llmProvider, process.env.LLM_MODEL)
const provider = createProvider({
  provider: config.llmProvider,
  apiKey: config.apiKeyForProvider,
  model: modelConfig.model,
})
```

**Environment Variables (extends Ticket 006)**

```bash
# .env.local

# Provider selection (required)
LLM_PROVIDER=anthropic              # or openai, gemini, ollama

# Optional: override default model
LLM_MODEL=claude-3-opus-20250805    # If not set, use default for provider

# Optional: tuning
LLM_MAX_TOKENS=4096                 # Default per provider
LLM_TEMPERATURE=0.7                 # Default 0.7
```

**Configuration Validation**

```typescript
// Validation rules (Zod schema)
const ModelConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
  model: z.string(),                // Trust the user; will fail at API call if invalid
  maxTokens: z.number().int().min(100).max(100000),
  temperature: z.number().min(0).max(2),
})

// Load from env + validate
function loadModelConfig(): ModelConfig {
  const provider = process.env.LLM_PROVIDER as SupportedProvider
  const overrideModel = process.env.LLM_MODEL
  const maxTokens = process.env.LLM_MAX_TOKENS ? parseInt(process.env.LLM_MAX_TOKENS, 10) : undefined
  const temperature = process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined

  const config = selectModel(provider, overrideModel)
  
  if (maxTokens) config.maxTokens = maxTokens
  if (temperature !== undefined) config.temperature = temperature

  return ModelConfigSchema.parse(config)
}
```

**Startup Logging**

```typescript
// Log selected model at startup
const modelConfig = loadModelConfig()
console.log(`✓ Model loaded: provider=${modelConfig.provider}, model=${modelConfig.model}`)
console.log(`  maxTokens=${modelConfig.maxTokens}, temperature=${modelConfig.temperature}`)
```

**Example Scenarios**

| Scenario | Config | Result |
|----------|--------|--------|
| `LLM_PROVIDER=anthropic` | Use defaults | claude-3-5-sonnet, max 4096 tokens |
| `LLM_PROVIDER=anthropic LLM_MODEL=claude-3-opus-...` | Override model | claude-3-opus, max 4096 tokens |
| `LLM_PROVIDER=openai` | Use defaults | gpt-4-turbo, max 4096 tokens |
| `LLM_PROVIDER=ollama LLM_MAX_TOKENS=2048` | Tune tokens | mistral, max 2048 tokens |

#### Context-Aware Model Selection (V2 - Future)

**Future architecture:**

```typescript
// Not for V1, but shows future direction
type TaskContext = 'planning' | 'coding' | 'validation'

interface ModelPerContext {
  planning: ModelConfig      // Big brain: claude-3-opus
  coding: ModelConfig        // Efficient: claude-3-haiku
  validation: ModelConfig    // Cost-effective: gpt-4-mini
}

// V2 ticket will implement:
// - Load per-context model config
// - Select model based on agent task type
// - Log context + model switch for observability
```

#### Non-Goals (V1)

- ❌ Dynamic model switching during agent loop (V2)
- ❌ Cost optimization based on token budget (future)
- ❌ Fallback model if primary fails (ticket 005 error handling)
- ❌ Model A/B testing or multi-model voting

#### Model Requirements & Constraints

**Anthropic (claude):**
- Requires `ANTHROPIC_API_KEY`
- Best models: claude-3-5-sonnet, claude-3-opus, claude-3-haiku
- Tool use support: ✓

**OpenAI:**
- Requires `OPENAI_API_KEY`
- Best models: gpt-4-turbo, gpt-4o, gpt-3.5-turbo
- Tool use support: ✓

**Google Gemini:**
- Requires `GEMINI_API_KEY`
- Best models: gemini-2.0-flash, gemini-1.5-pro
- Tool use support: ✓

**Ollama (local):**
- No API key required
- Models: mistral, llama2, neural-chat (whatever is installed locally)
- Tool use support: Limited (depends on model)
- Default endpoint: http://localhost:11434

#### Integration Points

- **Ticket 006**: Provider and model selected from config.env
- **Ticket 001**: KB mission mentions agent capabilities (partly determined by model)
- **Ticket 004**: Tool invocation envelope includes model metadata
- **Ticket 005**: Error handling includes "model not available" errors
- **Future**: Ticket [Context-aware model selection] will extend this

#### Decisions Made

- ✅ **V1 single model**: One model drives all KB agent tasks
- ✅ **Env-var configured**: LLM_PROVIDER + optional LLM_MODEL override
- ✅ **Sensible defaults**: Per-provider defaults, no hardcoding needed
- ✅ **Startup validation**: Fail fast if model config invalid (Ticket 005)
- ✅ **Future-proof architecture**: Easy to add context-aware selection later
- ✅ **Logged at startup**: Clear visibility into which model is active

#### Open Questions (Time-boxed or Future)

- **Model pricing**: Should we track / estimate cost per model? → **Future (cost tracking ticket).**
- **Model capabilities matrix**: Should we document which models support streaming, tool use, etc.? → **Future (model compatibility matrix).**
- **Fallback chains**: If selected model is down, should we auto-fallback? → **No, defer to error handling (ticket 005).**
- **Context-aware selection**: When should we use smaller models vs big models? → **Future ticket (V2 model selection).**

#### Validation & Closure

This implementation plan establishes:
- ✅ V1 policy: Single model per KB instance, env-var configured
- ✅ Default models defined per provider (sensible choices)
- ✅ Override capability (LLM_MODEL env var)
- ✅ Tuning options (maxTokens, temperature)
- ✅ Startup logging for visibility
- ✅ V2 roadmap clear (context-aware selection)
- ✅ Integration points identified

**Ticket 037 is now closed.**
