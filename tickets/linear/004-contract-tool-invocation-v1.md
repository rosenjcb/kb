# Freeze tool invocation envelope v1

## Ticket ID
004

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

### Tool Invocation Envelope (Request/Response Cycle)

#### Background
Tools are the primary mechanism for agents to perform actions (write documents, check KB, run audits). Each tool invocation must be wrapped with a stable envelope that includes metadata for observability, cost tracking, and error handling. The envelope format must work consistently across MCP, different LLM providers, and future execution contexts.

#### Approach
Define a minimal tool invocation envelope with unique IDs (per invocation, not idempotent), comprehensive execution metrics, and simple binary error handling. Tools are stateless and return results to the LLM for decision-making (no tool chaining at the invocation level).

#### Examples / Specifications

**Type Definitions:**

```typescript
// Tool invocation requested by LLM
interface ToolUseRequest {
  id: string                      // Unique per invocation (ULID/UUID, not idempotent)
  name: string                    // Tool name (e.g., "write_document")
  input: Record<string, unknown>  // Tool-specific input JSON
}

// Tool execution result envelope
interface ToolResultEnvelope {
  toolUseId: string               // Matches request ID
  toolName: string                // Echo tool name
  success: boolean                // Binary: true if no error, false if error
  content: unknown                // Tool output (varies by tool)
  error?: string                  // Error message if success=false
  metrics: ToolExecutionMetrics   // See below
}

// Comprehensive execution metrics
interface ToolExecutionMetrics {
  startTime: string               // ISO 8601 timestamp when tool execution started
  durationMs: number              // Total wall-clock time (milliseconds)
  permissionCheckDurationMs?: number // Time spent validating tool permissions
  preHookDurationMs?: number      // Time spent in pre-execution hooks
  resultSizeBytes: number         // Size of result in bytes (for budget tracking)
}

// Report when tool execution completes
interface ToolExecutionReport {
  requestedAt: string             // ISO 8601 when agent requested tool
  completedAt: string             // ISO 8601 when execution finished
  toolInvocations: ToolResultEnvelope[]
  summary: {
    total: number
    succeeded: number
    failed: number
    totalDurationMs: number
    totalResultSizeBytes: number
  }
}
```

**Example Request (Agent → Tool Executor):**

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "write_document",
  "input": {
    "title": "Auth Architecture Decision",
    "content": "# Authentication\n\nWe use JWT...",
    "tags": ["architecture", "decision"]
  }
}
```

**Example Success Response (Tool Executor → Agent):**

```json
{
  "toolUseId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "toolName": "write_document",
  "success": true,
  "content": {
    "id": "01AS9Z5QERF3N4YD6JK9L2WX",
    "title": "Auth Architecture Decision",
    "filePath": "/kb/docs/01AS9Z5QERF3N4YD6JK9L2WX.md",
    "createdAt": "2026-04-12T14:35:22Z",
    "updatedAt": "2026-04-12T14:35:22Z"
  },
  "metrics": {
    "startTime": "2026-04-12T14:35:22.100Z",
    "durationMs": 145,
    "permissionCheckDurationMs": 12,
    "preHookDurationMs": 5,
    "resultSizeBytes": 287
  }
}
```

**Example Error Response (Tool Executor → Agent):**

```json
{
  "toolUseId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "toolName": "write_document",
  "success": false,
  "content": null,
  "error": "write_document: document 01AS9Z5... already exists; use overwrite=true or provide a new title",
  "metrics": {
    "startTime": "2026-04-12T14:35:22.100Z",
    "durationMs": 28,
    "permissionCheckDurationMs": 2,
    "preHookDurationMs": 1,
    "resultSizeBytes": 412
  }
}
```

#### Request/Response Flow (MCP & Agent Loop)

**Sequence:**

1. Agent decides tool is needed; calls LLM with tool definitions + messages
2. LLM responds with `ToolUseRequest[]` (may be multiple tools, but we handle serially for now)
3. Agent executor calls each tool sequentially using the request envelope
4. Executor wraps result in `ToolResultEnvelope` with metrics
5. Agent adds envelope to message history: `{ role: 'user', content: [toolResultEnvelope] }`
6. Agent calls LLM again with updated history
7. LLM decides: more tools, text response, or done

**Pseudo-code:**

```typescript
async function executeToolInvocation(req: ToolUseRequest): Promise<ToolResultEnvelope> {
  const startTime = performance.now()
  const permissionStart = performance.now()
  
  // 1. Check permissions
  const allowed = await checkPermissions(req.name)
  const permissionCheckDurationMs = performance.now() - permissionStart
  
  if (!allowed) {
    return {
      toolUseId: req.id,
      toolName: req.name,
      success: false,
      error: `Tool '${req.name}' denied by permission policy`,
      metrics: {
        startTime: new Date().toISOString(),
        durationMs: performance.now() - startTime,
        permissionCheckDurationMs,
        resultSizeBytes: 0,
      },
    }
  }

  // 2. Run pre-hooks
  const preHookStart = performance.now()
  await runPreHooks(req)
  const preHookDurationMs = performance.now() - preHookStart

  // 3. Execute tool
  const toolStart = performance.now()
  let result
  let succeeded = true
  let error = undefined

  try {
    result = await toolRegistry.get(req.name).call(req.input)
  } catch (err) {
    succeeded = false
    error = err instanceof Error ? err.message : String(err)
    result = null
  }

  const durationMs = performance.now() - startTime

  // 4. Return envelope with metrics
  return {
    toolUseId: req.id,
    toolName: req.name,
    success: succeeded,
    content: result,
    error,
    metrics: {
      startTime: new Date().toISOString(),
      durationMs: Math.round(durationMs),
      permissionCheckDurationMs: Math.round(permissionCheckDurationMs),
      preHookDurationMs: Math.round(preHookDurationMs),
      resultSizeBytes: JSON.stringify(result).length,
    },
  }
}
```

#### Metrics Rationale

**Why track these metrics:**
- `durationMs`: Cost estimation, latency budgets, timeout detection
- `permissionCheckDurationMs`: Audit overhead, caching opportunities
- `preHookDurationMs`: Execution profiling, optimization targets
- `resultSizeBytes`: Token budget enforcement, output size limits
- `startTime`: Causal tracing, multi-transaction ordering

#### Tool Execution Guarantees

| Aspect | Guarantee |
|--------|-----------|
| **ID Uniqueness** | Each invocation gets a new ULID/UUID; not idempotent |
| **Error Handling** | Binary `success` flag; errors in `error` field; never throw |
| **Execution Model** | Serial execution (one tool at a time, sequentially) |
| **Tool Chaining** | No direct chaining; agent LLM decides next tool |
| **Concurrency** | Future optimization: partition read-only tools for parallel execution (ticket TBD) |
| **Timeout** | Tool must complete or timeout; return error with metrics |
| **Result Size** | No hard limit; metric tracked for budgeting |

#### Error Conditions

| Condition | Response | Metrics Included? |
|-----------|----------|-------------------|
| Tool not found | `success=false`, error="Tool not found" | Yes |
| Permission denied | `success=false`, error="Tool denied by policy" | Yes |
| Input validation failed | `success=false`, error="Invalid input: ..." | Yes |
| Tool execution timeout | `success=false`, error="Tool timeout after 30s" | Yes |
| Internal tool error | `success=false`, error="Tool error: ..." | Yes |
| Tool success | `success=true`, content=result | Yes |

#### Integration Points

- **Ticket 001** (KB Mission): Tools are how agents modify KB documents
- **Ticket 002** (DocumentWriter): `write_document` tool uses this envelope
- **Ticket 005** (Error Taxonomy): Error messages structured per this envelope
- **Ticket 017** (MCP tool registration): MCP tools exposed via this envelope
- **Ticket 035** (Contract test matrix): Envelope format tested against all providers

#### Decisions Made

- ✅ **Unique IDs per invocation**: Each tool call gets new ULID/UUID (not idempotent by ID)
- ✅ **Comprehensive metrics**: Track duration, permission check time, pre-hooks, result size
- ✅ **Binary error handling**: Simple `success` flag + `error` message (complexity deferred)
- ✅ **Stateless tools**: Tools return results to LLM; no direct chaining at invocation level
- ✅ **Serial execution**: One tool at a time for now; parallel execution in future ticket
- ✅ **Result envelope**: All information needed by agent to continue (result + metrics + error)

#### Open Questions (Time-boxed or Future)

- **Partial results**: Should tools support partial success (e.g., "wrote 85 of 100 docs, 15 failed")? → **Future: ticket (error taxonomy refinement).**
- **Concurrent execution**: Should we partition read-only vs write tools for parallel execution? → **Future ticket (execution optimization).**
- **Result caching**: Should identical tool invocations return cached results? → **Future ticket (caching strategy).**
- **Tool versioning**: How do we handle tool API changes over time? → **Future ticket (versioning policy).**
- **Streaming results**: Should large results stream incrementally? → **Future ticket (streaming envelope).**

#### Validation & Closure

This implementation plan establishes:
- ✅ Tool invocation envelope with unique ID per call
- ✅ Result structure: success/content/error with comprehensive metrics
- ✅ Metrics tracked: duration, permission check time, pre-hook time, result size
- ✅ Binary error handling (simple for v1)
- ✅ Serial execution model (stateless tools, LLM decides next action)
- ✅ No tool chaining (future optimization)
- ✅ Integration points clear (MCP tools, contract tests, KB operations)

**Ticket 004 is now closed.**
