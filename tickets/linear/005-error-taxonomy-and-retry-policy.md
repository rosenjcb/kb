# Define error taxonomy and retry policy

## Ticket ID
005

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

### Error Taxonomy and Retry Policy (Multi-Layer)

#### Background
Errors occur at multiple levels: LLM provider API failures, KB tool execution failures, validation errors, and logic errors (thought loops). Each layer must distinguish retryable from permanent errors and handle retries independently. The critical requirement: **external system errors (provider downtime) must NOT count toward agent retry budget**, to prevent infinite loops when the KB logic is correct but external services fail.

#### Approach
Define three error categories (transient, permanent, fatal) with layer-specific retry strategies. Provider retries are transparent to the agent; only internal KB logic retries count. Each layer enforces fallback guards to prevent infinite loops.

#### Examples / Specifications

**Error Type Definitions:**

```typescript
// Error classification
type ErrorCategory = 'transient' | 'permanent' | 'fatal'

interface ClassifiedError {
  category: ErrorCategory
  code: string                    // Machine-readable error code
  message: string                 // Human-readable message
  retryable: boolean              // Can be retried at this layer?
  layer: 'provider' | 'tool' | 'agent'  // Where error occurred
  originalError?: Error
}

// Retry context metadata
interface RetryContext {
  attempt: number                 // Current attempt (1-indexed)
  maxAttempts: number             // Max attempts for this error category
  layer: string                   // Provider, tool executor, or agent loop
  errorCategory: ErrorCategory
  firstAttemptAt: string          // ISO 8601 timestamp
  internalRetry: boolean          // Count toward agent budget (only KB logic, not provider)
}

// Retry policy per layer
interface RetryPolicy {
  transientMaxAttempts: number    // Default 3 for transient errors
  permanentMaxAttempts: number    // Default 1 for permanent errors
  baseDelayMs: number             // 500ms base exponential backoff
  maxDelayMs: number              // Cap at 60s (60000ms)
  respectRetryAfterHeader: boolean // Respect server-provided retry-after
}
```

**Error Categories by Layer & Type:**

#### Layer 1: LLM Provider (API)

**Transient errors (retry 3 times):**
- HTTP 429 (Rate limit) — respect Retry-After header
- HTTP 408 (Request timeout)
- HTTP 5xx (Server error)
- Connection errors (ECONNRESET, EPIPE, ENOTFOUND, timeout)

**Permanent errors (do NOT retry):**
- HTTP 400 (Bad request / invalid payload)
- HTTP 401 (Auth failed)
- HTTP 403 (Forbidden)

**Fatal errors (fail immediately):**
- HTTP 413 (Payload too large)

**Retry strategy:**
```typescript
function shouldRetryProviderError(status: number, error: Error): boolean {
  if (status >= 500) return true           // 5xx = transient
  if (status === 429) return true          // Rate limit = transient
  if (status === 408) return true          // Timeout = transient
  if (status === 400 || status === 401 || status === 403) return false  // Permanent
  return false
}

function getExponentialBackoff(attempt: number, retryAfter?: string): number {
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) return seconds * 1000  // Respect server header
  }
  
  const baseDelay = 500  // 500ms
  const exponential = baseDelay * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, 60000)  // Cap at 60s
  const jitter = Math.random() * 0.25 * capped  // ±25% jitter
  return capped + jitter
}
```

**Example: Rate Limit (429)**
```
Attempt 1: API call → 429 Retry-After: 10s → Wait 10s (respect header)
Attempt 2: API call → 429 Retry-After: 20s → Wait 20s
Attempt 3: API call → 429 Retry-After: 30s → Wait 30s
Attempt 4: Fail with error (max 3 attempts reached)
Agent sees: ProviderError (does NOT count toward agent retry budget)
```

**NOT counted in agent retry budget:** These are external failures.

---

#### Layer 2: Tool Executor (KB Tools)

**Transient errors (retry 3 times):**
- Temporary storage failures ("disk temporarily unavailable")
- Timeout executing tool (e.g., external API call within tool)
- Validation errors that might be temporary (e.g., "concurrent write, try again")

**Permanent errors (do NOT retry):**
- Missing required input field
- Invalid input format / validation failed
- Permission denied
- Document already exists (conflict, overwrite=false)
- Tool not found

**Retry strategy:**
```typescript
function shouldRetryToolError(error: ToolError): boolean {
  const code = error.code
  if (code === 'TEMP_STORAGE_ERROR') return true
  if (code === 'TOOL_TIMEOUT') return true
  if (code === 'CONCURRENT_WRITE_RETRY') return true
  
  if (code === 'VALIDATION_ERROR') return false
  if (code === 'PERMISSION_DENIED') return false
  if (code === 'CONFLICT') return false
  if (code === 'NOT_FOUND') return false
  
  return false  // Default: don't retry
}
```

**Example: Tool Execution Failure**
```
Tool: write_document
Error: "TEMP_STORAGE_ERROR: disk write failed"
Retry 1: wait 500ms → try again → success
Agent sees: tool executed successfully (counts as part of task, not a retry)
```

**Counted in agent retry budget ONLY if internal KB logic error** (e.g., agent called wrong tool repeatedly).

---

#### Layer 3: Agent Loop (KB Logic)

**Transient errors (retry 3 times):**
- Agent thought loop: called same tool repeatedly with same/similar input
- Agent exceeds max turns but could continue (explicit request to extend)

**Permanent errors (do NOT retry):**
- Agent explicitly said "done" or user said stop
- Out of tokens (no recovery possible)

**Fallback guards (prevent infinite loops):**

```typescript
const MAX_AGENT_TURNS = 10              // Hard limit on agent loop turns
const MAX_SAME_TOOL_CALLS = 3           // Max times agent can call same tool in a row
const MAX_AGENT_RETRIES = 3             // Max times we extend agent beyond limits
const TOTAL_RETRY_BUDGET_MS = 60_000    // 60 second total budget for ALL retries

interface AgentLoopMetrics {
  turnCount: number
  sameToolCallCount: number             // Consecutive calls to same tool
  retryCount: number                    // Count of internal retries only
  totalRetryTimeMs: number              // Time spent retrying (wall clock)
}

async function* agentLoop(...): AsyncGenerator<AgentEvent> {
  const metrics: AgentLoopMetrics = { turnCount: 0, sameToolCallCount: 0, retryCount: 0, totalRetryTimeMs: 0 }
  let lastToolName = null
  let retryBudgetRemaining = TOTAL_RETRY_BUDGET_MS
  
  while (metrics.turnCount < MAX_AGENT_TURNS) {
    metrics.turnCount++
    const response = await provider.call(...)  // Provider retries are transparent here
    
    // Check for thought loop
    if (response.toolUses.length === 1) {
      const toolName = response.toolUses[0].name
      if (toolName === lastToolName) {
        metrics.sameToolCallCount++
      } else {
        metrics.sameToolCallCount = 1
        lastToolName = toolName
      }
      
      if (metrics.sameToolCallCount >= MAX_SAME_TOOL_CALLS) {
        // Thought loop detected
        yield { type: 'done', reason: 'thought_loop_detected' }
        break
      }
    }
    
    // Execute tools and continue...
  }
  
  if (metrics.turnCount >= MAX_AGENT_TURNS && metrics.retryCount < MAX_AGENT_RETRIES && retryBudgetRemaining > 0) {
    // Agent hit turn limit but could continue
    metrics.retryCount++
    metrics.totalRetryTimeMs += (Date.now() - startTime)
    if (metrics.totalRetryTimeMs < TOTAL_RETRY_BUDGET_MS) {
      // Could extend for one more retry, but explicit decision needed
      yield { type: 'decision', decision: 'max_turns_reached', canRetry: true, retryCount: metrics.retryCount }
    }
  }
}
```

---

#### Retry Budget Isolation (Key Design)

**Provider retries are NOT counted:**
- LLM API calls 429/5xx and retry transparently
- Agent doesn't know retry happened
- Counts toward wall-clock time but NOT agent retry budget
- Example: Provider retried 3 times over 45 seconds for a 429 error → Agent sees single result with latency, doesn't count as agent retry

**Internal KB retries ARE counted:**
- Agent called same tool 3+ times with same input (thought loop)
- Agent hit max turns but extended once
- These count toward TOTAL_RETRY_BUDGET_MS (60 seconds)
- Once budget exhausted, agent must stop

**Contract with consumer:**
```typescript
interface AgentExecutionReport {
  finalState: 'success' | 'max_turns' | 'thought_loop' | 'out_of_tokens' | 'error'
  metrics: {
    agentTurns: number
    internalRetries: number        // Only KB logic retries
    totalWallClockMs: number       // Real time elapsed (includes provider retries)
    totalRetryBudgetMs: number     // Time spent in KB-internal retries
  }
}
```

Consumer doesn't care about provider retry count; only agent turn count and internal retry count matter.

---

#### Error Codes Reference

**Provider Layer:**

| Code | Category | Retryable | Meaning |
|------|----------|-----------|---------|
| `PROVIDER_RATE_LIMIT` | transient | Yes (3x) | HTTP 429, respect Retry-After |
| `PROVIDER_TIMEOUT` | transient | Yes (3x) | HTTP 408 or network timeout |
| `PROVIDER_SERVER_ERROR` | transient | Yes (3x) | HTTP 5xx |
| `PROVIDER_INVALID_REQUEST` | permanent | No | HTTP 400 (bad payload) |
| `PROVIDER_AUTH_FAILED` | permanent | No | HTTP 401/403 |
| `PROVIDER_PAYLOAD_TOO_LARGE` | fatal | No | HTTP 413 |

**Tool Layer:**

| Code | Category | Retryable | Meaning |
|------|----------|-----------|---------|
| `TOOL_TEMP_STORAGE_ERROR` | transient | Yes (3x) | Disk/temp failure |
| `TOOL_TIMEOUT` | transient | Yes (3x) | Tool didn't complete in time |
| `TOOL_VALIDATION_ERROR` | permanent | No | Input validation failed |
| `TOOL_PERMISSION_DENIED` | permanent | No | Auth/policy rejected |
| `TOOL_CONFLICT` | permanent | No | Document exists, overwrite=false |
| `TOOL_NOT_FOUND` | permanent | No | Unknown tool name |

**Agent Layer:**

| Code | Category | Meaning |
|------|----------|---------|
| `AGENT_THOUGHT_LOOP` | transient | Same tool 3x in a row |
| `AGENT_MAX_TURNS` | transient | Hit turn limit, could extend |
| `AGENT_OUT_OF_TOKENS` | fatal | No tokens left, can't continue |

---

#### Integration Points

- **Ticket 001**: Error conditions documented in KB mission
- **Ticket 004**: Tool invocation envelope includes error codes
- **Ticket 017**: MCP tool responses use this error taxonomy
- **Ticket 034**: Provider failure playbook uses these error categories
- **Ticket 035**: Contract tests validate retry behavior per category

#### Decisions Made

- ✅ **Three error categories**: transient (3 retries), permanent (no retry), fatal (fail fast)
- ✅ **Exponential backoff**: 500ms base * 2^(attempt-1), capped at 60s, ±25% jitter
- ✅ **Respect Retry-After header**: Use server-provided wait time if present
- ✅ **Provider retries transparent**: Don't count toward agent budget
- ✅ **Internal retries budgeted**: Only KB logic retries count; 60s total budget
- ✅ **Thought loop detection**: Consecutive same-tool calls (3x) trigger agent stop
- ✅ **Multi-layer retry isolation**: Each layer handles its own retries; don't cascade

#### Open Questions (Time-boxed or Future)

- **Circuit breaker pattern**: Should we fast-fail after N consecutive provider errors instead of retrying? → **Future ticket (resilience patterns).**
- **Adaptive backoff**: Should we learn from historical failures and adjust delays per provider? → **Future ticket (ML-based retry optimization).**
- **Retry metrics logging**: Should retries be logged for observability/debugging? → **Future ticket (ticket 033: Observability event catalog).**
- **User-configurable retry policy**: Should consumers set retry limits (max turns, max retries)? → **Future ticket (KB configuration contract).**

#### Validation & Closure

This implementation plan establishes:
- ✅ Error taxonomy with three categories across three layers (provider, tool, agent)
- ✅ Retry strategy: exponential backoff, max 3 attempts for transient, 1 for permanent
- ✅ Retry budget isolation: provider retries transparent, internal retries counted
- ✅ Fallback guards: max turns, max same-tool calls, total budget timeout
- ✅ Thought loop detection: agent stops after 3 consecutive same-tool calls
- ✅ Error codes reference table for all layers
- ✅ Integration points clear (MCP tools, playbooks, contract tests)

**Ticket 005 is now closed.**
