# TICKET-003: LLM Jury Semantic Loss (`L_jury`)

**Status:** Open  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, correctness, llm-judge

## Context

Structural AST matching catches syntactic errors but cannot evaluate semantic correctness. This requires language model evaluation. However, a single LLM judge is unreliable — it will approve incorrect answers (low True Negative Rate) and be influenced by response length.

`src/core/llm-provider.ts` already defines `AnthropicProvider`, `OpenAIProvider`, `GeminiProvider`, and `OllamaProvider` behind a common `LLMProvider` interface. The jury ensemble uses these directly — no new SDK dependencies, no new HTTP clients. The providers are already wired to the `src/cli/kb-config.ts` credential resolution.

## Objective

Implement an ensemble jury system that sends candidate output `Y` to `K` distinct LLM judges via the existing `LLMProvider` interface and applies minority-veto policy to produce a normalized semantic loss in `[0, 1]`.

## Acceptance Criteria

- [ ] Accepts: candidate string `Y`, reference string `Y*`, rubric `R: string[]` (one atomic claim per item).
- [ ] Queries at least `K = 3` judge instances using the existing `LLMProvider` interface from `src/core/llm-provider.ts`. Each judge must be a different model or provider family to mitigate self-enhancement bias.
- [ ] Each judge grades each rubric item 0–5 via the meta-prompt template (see below).
- [ ] Minority-veto: if `V >= 2` judges emit `veto_flag: true`, the run receives `L_jury = 1.0`.
- [ ] Without veto: `L_jury = 1 - (meanScore / 5)` averaged across rubric items and judges.
- [ ] Malformed JSON responses from a judge are treated as a veto.
- [ ] Judge configs (provider, model) are passed in as an array — not hardcoded — so the caller controls which models are used.
- [ ] Unit tests cover: all judges agree, one judge vetoes, two judges veto (triggers veto policy), malformed JSON, all rubric items score 5 → loss = 0.

## Meta-Prompt Template

```
You are an expert software engineering judge evaluating an agent's output.

Step 1: List all functional requirements from the task specification.
Step 2: Examine the candidate output step-by-step for logic errors, missing information, or hallucinated facts.
Step 3: Grade each rubric item from 0 to 5:
  - 0: Complete failure to address the requirement
  - 1-2: Major bugs or errors present
  - 3-4: Minor issues, logic is correct
  - 5: Perfect compliance

Rubric items:
{rubricItems}

Candidate output:
{candidate}

Reference output:
{reference}

Respond ONLY in valid JSON:
{
  "analysis": "<step-by-step reasoning — must be non-empty>",
  "scores": { "rubric_1": <int>, "rubric_2": <int>, ... },
  "veto_flag": <bool>,
  "veto_reason": "<string, empty if no veto>"
}
```

## LLMProvider Interface (exact, from `src/core/types.ts`)

```typescript
// From src/core/types.ts — the interface the jury must program against
export interface LLMProvider {
  readonly name: string
  readonly model: string
  readonly supportsStreaming: boolean

  call(params: LLMCallParams): Promise<LLMResponse>
  callStream?(params: LLMCallParams): AsyncGenerator<LLMStreamChunk>
}

export interface LLMCallParams {
  messages: Message[]               // Message[] — see below
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  systemPrompt?: string             // hoisted to provider-native system role
  thinkingBudget?: number           // Gemini 2.5+ only; set 0 to disable CoT
  structuredJson?: LLMStructuredJsonRequest  // native JSON mode per provider
}

export interface LLMResponse {
  text: string                      // full response text — parse JSON from here
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error'
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  usage: { inputTokens: number; outputTokens: number }
}

export interface Message {
  role: 'user' | 'assistant'
  content: string | ToolResultBlock[]
  toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  metadata?: { timestamp: number; tokenCount?: number; model?: string }
}
```

**The jury only uses `call()`, never `callStream?()`.** `LLMResponse.text` contains the raw model output; parse JSON from it directly.

## Provider Constructors (exact, from `src/core/llm-provider.ts`)

All three cloud providers share the same two-argument constructor shape: `(apiKey: string, model?: string)`. The Ollama constructor differs.

```typescript
// AnthropicProvider — default model: 'claude-haiku-4-5'
new AnthropicProvider(apiKey: string, model?: string)
// e.g. new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, 'claude-opus-4-5')

// OpenAIProvider — default model: 'gpt-4-turbo'
new OpenAIProvider(apiKey: string, model?: string)
// e.g. new OpenAIProvider(process.env.OPENAI_API_KEY!, 'gpt-4o')

// GeminiProvider — default model: 'gemini-2.5-flash'
new GeminiProvider(apiKey: string, model?: string)
// e.g. new GeminiProvider(process.env.GEMINI_API_KEY!, 'gemini-2.5-pro')

// OllamaProvider — no API key; uses HTTP endpoint instead
new OllamaProvider(endpoint?: string, model?: string)
// endpoint defaults to 'http://localhost:11434'; model defaults to 'mistral'
```

**Do not construct providers with `new` directly in `jury-loss.ts`.** Use the factory exported from `src/core/llm-provider.ts`:

```typescript
import { createProvider } from '../core/llm-provider'

// createProvider signature:
export function createProvider(config: {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey?: string      // required for anthropic, openai, gemini; throws if missing
  endpoint?: string    // ollama only
  model?: string
}): LLMProvider
```

## Credential Resolution (from `src/cli/kb-config.ts`)

The jury must not hardcode API keys. Use the same pattern that the rest of the application uses:

```typescript
import {
  resolveLLMProvider,   // ResolvedLLM = { provider, apiKey?, endpoint?, model? }
  readKbConfig,
} from '../cli/kb-config'

// Resolves provider + key from env vars, with config file as hint:
// Priority: ANTHROPIC_API_KEY → OPENAI_API_KEY → GEMINI_API_KEY → OLLAMA_ENDPOINT
const config = await readKbConfig()
const resolved = resolveLLMProvider(config)
// resolved.apiKey comes from process.env[PROVIDER_API_KEY]
```

Environment variables read by the resolver (in priority order):

| Provider    | Env var               |
|-------------|----------------------|
| `anthropic` | `ANTHROPIC_API_KEY`  |
| `openai`    | `OPENAI_API_KEY`     |
| `gemini`    | `GEMINI_API_KEY`     |
| `ollama`    | `OLLAMA_ENDPOINT`    |

For the jury specifically, the caller supplies the judge array directly (see `JudgeConfig` below). The credential resolver is only needed if the caller wants to auto-populate a judge from the user's configured default provider.

## JudgeConfig Type (define in `eval/losses/jury-loss.ts`)

```typescript
export interface JudgeConfig {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  model: string           // must be explicit — no provider defaults
  apiKey?: string         // required for cloud providers; read from env if omitted
  endpoint?: string       // ollama only
}
```

Instantiate each judge by calling `createProvider({ provider, apiKey, endpoint, model })`. If `apiKey` is omitted, read it from the matching env var before calling `createProvider` (mirror `resolveLLMProvider`'s env-var lookup).

## JSON Response Parsing

The judge's JSON comes back in `LLMResponse.text`. Parse defensively:

```typescript
// Define the expected judge response shape
interface JudgeVerdict {
  analysis: string
  scores: Record<string, number>   // keys: "rubric_1", "rubric_2", ...
  veto_flag: boolean
  veto_reason: string
}

function parseVerdict(raw: string): JudgeVerdict | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.analysis !== 'string' ||
      parsed.analysis.trim() === '' ||          // empty analysis = malformed
      typeof parsed.scores !== 'object' ||
      parsed.scores === null ||
      typeof parsed.veto_flag !== 'boolean'
    ) {
      return null   // treated as veto by the caller
    }
    return parsed as unknown as JudgeVerdict
  } catch {
    return null     // JSON.parse failure = treated as veto
  }
}
```

`null` from `parseVerdict` counts as a veto vote. The caller increments the veto counter before applying minority-veto policy.

## Native JSON Mode (Optional Enhancement)

Two of the three providers support native structured JSON output which eliminates parse failures for well-formed responses. Use `LLMCallParams.structuredJson` when available:

- **OpenAI** (`OpenAIProvider`): set `structuredJson.openai = { name: 'JudgeVerdict', schema: <JSON Schema> }`. The provider sets `response_format.type: 'json_schema'` with `strict: true`.
- **Gemini** (`GeminiProvider`): set `structuredJson.gemini = <JSON Schema>` and optionally `thinkingBudget: 0` to prevent Gemini 2.5+ from consuming output tokens on internal reasoning before the JSON response. The provider sets `responseMimeType: 'application/json'` and `responseSchema`.
- **Anthropic** (`AnthropicProvider`): no native JSON mode in this provider implementation. Rely on prompt-level instruction and `parseVerdict()`.

When native JSON mode is active, `LLMResponse.text` still contains the JSON string — `parseVerdict` is always the final parse step.

## Calling a Judge (LLMCallParams shape)

```typescript
const params: LLMCallParams = {
  systemPrompt: 'You are an expert software engineering judge evaluating an agent\'s output.',
  messages: [
    {
      role: 'user',
      content: filledPrompt,   // string — the meta-prompt with {rubricItems}, {candidate}, {reference} substituted
    }
  ],
  maxTokens: 2048,
  temperature: 0,              // deterministic — judges should not be creative
  // For OpenAI judges:
  structuredJson: { openai: { name: 'JudgeVerdict', schema: judgeVerdictJsonSchema } },
  // For Gemini judges:
  // structuredJson: { gemini: judgeVerdictJsonSchema },
  // thinkingBudget: 0,
}

const response: LLMResponse = await judge.call(params)
const verdict = parseVerdict(response.text)
```

Note: `systemPrompt` is hoisted to the provider-native system mechanism by each provider's `call()` implementation — it does not need to be prepended to `messages` manually.

## Implementation Notes

The `analysis` field must be non-empty — this is the "slow thinking" requirement that forces the judge to reason before scoring. A response with an empty `analysis` is treated as malformed and counts as a veto.

The jury runner should log each judge's raw `LLMResponse.text` to the trajectory (via `TrajectoryCollector` from TICKET-001) so the full decision chain is auditable. Log `response.usage` (inputTokens, outputTokens) alongside the raw text.

## Files to Create

- `eval/losses/jury-loss.ts` — `JudgeConfig` type, `parseVerdict()`, jury orchestration, `L_jury` computation
- `eval/prompts/judge-meta-prompt.txt` — the meta-prompt template with `{rubricItems}`, `{candidate}`, `{reference}` placeholders

## Files to Reference (do not modify)

- `src/core/llm-provider.ts` — `createProvider` factory, `AnthropicProvider`, `OpenAIProvider`, `GeminiProvider`, `OllamaProvider`
- `src/core/types.ts` — `LLMProvider`, `LLMCallParams`, `LLMResponse`, `LLMStreamChunk`, `Message`
- `src/cli/kb-config.ts` — `resolveLLMProvider(config: KbConfig): ResolvedLLM`, `readKbConfig()`, env-var lookup order

## Dependencies

TICKET-001

## Feeds Into

TICKET-006, TICKET-007, TICKET-008
