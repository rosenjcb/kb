# Tool Executor and Dispatch Logic

## Ticket ID
009

## Theme
foundation

## Problem
Agent loop needs to execute tools (write_document, query_documents). Must consistently dispatch tool calls, handle results, and propagate errors. Provides the bridge between agent decisions and actual actions.

## Scope
- Define tool registry and registration pattern
- Specify tool invocation flow (request → execution → result envelope)
- Define success/error result handling
- Add concrete examples

## Acceptance Criteria
- Tool registry pattern clear
- Invocation flow unambiguous
- Error handling aligned with Ticket 005
- Integration with agent loop explicit

## Dependencies
002,004,005,008

## Deliverables
- ToolExecutor interface and registry pattern
- Tool invocation flow diagram
- Error handling examples

## Estimate
S

## Priority
TBD

---

## Implementation Plan

### Tool Executor and Dispatch Logic

#### Background
The agent loop yields tool use requests; something must execute them. The executor dispatches to registered tools, wraps results in the envelope from Ticket 004, collects metrics, and handles errors per Ticket 005.

#### Approach
Define a simple registry pattern: tools register with a name and handler function. Executor validates requests, dispatches to matching tool, captures metrics, wraps results. Errors are classified (Ticket 005) and returned in the envelope, never thrown.

#### Examples / Specifications

**Tool Definition & Registration:**

```typescript
// From Ticket 002 / Ticket 008
interface DocumentWriter {
  writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult>
}

interface DocumentReader {
  queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse>
}

// Tool executor interface
interface ExecutableTool {
  name: string
  execute(input: Record<string, unknown>): Promise<unknown>  // Returns tool-specific result
}

interface ToolRegistry {
  register(tool: ExecutableTool): void
  get(name: string): ExecutableTool | undefined
  list(): ExecutableTool[]
}

// Implementation
class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, ExecutableTool>()

  register(tool: ExecutableTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): ExecutableTool | undefined {
    return this.tools.get(name)
  }

  list(): ExecutableTool[] {
    return Array.from(this.tools.values())
  }
}
```

**Tool Executor:**

```typescript
interface ToolExecutionOptions {
  timeout?: number          // Default 30s
  checkPermissions?: (toolName: string) => Promise<boolean>
}

interface ToolExecutor {
  execute(
    request: ToolUseRequest,
    options?: ToolExecutionOptions
  ): Promise<ToolResultEnvelope>
}

class ToolExecutorImpl implements ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private options: ToolExecutionOptions = {}
  ) {}

  async execute(
    request: ToolUseRequest,
    localOptions?: ToolExecutionOptions
  ): Promise<ToolResultEnvelope> {
    const opts = { ...this.options, ...localOptions }
    const startTime = new Date().toISOString()
    const startMs = performance.now()

    // 1. Check tool exists
    const tool = this.registry.get(request.name)
    if (!tool) {
      const durationMs = performance.now() - startMs
      return {
        toolUseId: request.id,
        toolName: request.name,
        success: false,
        error: `Tool '${request.name}' not found`,
        metrics: {
          startTime,
          durationMs: Math.round(durationMs),
          resultSizeBytes: 0,
        },
      }
    }

    // 2. Check permissions (if provided)
    if (opts.checkPermissions) {
      const permissionStart = performance.now()
      const allowed = await opts.checkPermissions(request.name)
      const permissionCheckDurationMs = performance.now() - permissionStart

      if (!allowed) {
        const durationMs = performance.now() - startMs
        return {
          toolUseId: request.id,
          toolName: request.name,
          success: false,
          error: `Tool '${request.name}' denied by policy`,
          metrics: {
            startTime,
            durationMs: Math.round(durationMs),
            permissionCheckDurationMs: Math.round(permissionCheckDurationMs),
            resultSizeBytes: 0,
          },
        }
      }
    }

    // 3. Execute tool with timeout
    let result: unknown
    let error: string | undefined

    try {
      result = await Promise.race([
        tool.execute(request.input),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tool timeout')), opts.timeout ?? 30000)
        ),
      ])
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    const durationMs = performance.now() - startMs
    const resultSizeBytes = JSON.stringify(result ?? error).length

    return {
      toolUseId: request.id,
      toolName: request.name,
      success: !error,
      content: result,
      error,
      metrics: {
        startTime,
        durationMs: Math.round(durationMs),
        resultSizeBytes,
      },
    }
  }
}
```

**Startup: Initialize Registry & Tools**

```typescript
// In app.ts or cli entry point
async function initializeTools(config: Config): Promise<ToolRegistry> {
  const registry = new ToolRegistryImpl()

  // Create storage layer
  const writer = new MarkdownMDWriterTool({
    baseDir: config.kbBaseDir,
  })

  const reader = new MarkdownDocumentReader({
    baseDir: config.kbBaseDir,
  })

  // Register write_document tool
  registry.register({
    name: 'write_document',
    async execute(input: Record<string, unknown>) {
      const parsed = parseWriteDocumentInput(input)
      return writer.writeDocument(parsed)
    },
  })

  // Register query_documents tool
  registry.register({
    name: 'query_documents',
    async execute(input: Record<string, unknown>) {
      const parsed = parseQueryDocumentsInput(input)
      return reader.queryDocuments(parsed)
    },
  })

  console.log(`✓ Tools initialized: ${registry.list().map(t => t.name).join(', ')}`)
  return registry
}
```

**Agent Loop Integration:**

```typescript
async function* agentLoop(
  userQuery: string,
  provider: LLMProvider,
  toolRegistry: ToolRegistry,
  executor: ToolExecutor,
  config?: AgentLoopConfig
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [{ role: 'user', content: userQuery }]
  let turnCount = 0

  while (turnCount < (config?.maxTurns ?? 10)) {
    turnCount++

    // 1. Call LLM
    const response = await provider.call({
      messages,
      tools: toolRegistry.list().map(t => ({
        name: t.name,
        description: '[omitted]',
        schema: { /* ... */ },
      })),
    })

    // 2. Yield text
    if (response.text) {
      yield { type: 'text', content: response.text }
    }

    // 3. Execute tools
    const toolResults: ToolResultEnvelope[] = []

    for (const toolUse of response.toolUses) {
      const request: ToolUseRequest = {
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      }

      // Dispatch to executor
      const envelope = await executor.execute(request, {
        timeout: 30000,
        checkPermissions: async (name) => {
          // TODO: Implement permission checking (Ticket 039)
          return true
        },
      })

      yield {
        type: 'tool_result',
        toolUseId: envelope.toolUseId,
        result: envelope.content,
        isError: !envelope.success,
      }

      toolResults.push(envelope)
    }

    // 4. Continue loop with results or terminate
    if (!response.toolUses.length) {
      yield { type: 'done', reason: 'no_tool_calls' }
      break
    }

    // Add results back to message history and continue
    messages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result',
        toolUseId: r.toolUseId,
        toolName: r.toolName,
        result: r.success ? r.content : r.error,
        isError: !r.success,
      })),
    })
  }
}
```

**Tool Result Flow (via Message History):**

```
Agent (Claude) response:
  "I'll write a document for you."
  ToolUseRequest { id: '123', name: 'write_document', input: {...} }

Executor processes:
  → Validates input
  → Calls MarkdownMDWriterTool.writeDocument()
  → Returns ToolResultEnvelope with metrics

Agent loop adds to message history:
  ToolResultBlock { toolUseId: '123', result: {...}, isError: false }

Next LLM turn:
  Gets full conversation + tool results
  Decides: "Document written successfully. I can now read it."
  ToolUseRequest { id: '124', name: 'query_documents', input: {...} }
```

#### Error Classification (from Ticket 005)

Executor **never throws**. All errors classified and returned in envelope:

```typescript
// Tool not found
error: "Tool 'invalid_tool' not found"
result.success = false

// Permission denied
error: "Tool 'write_document' denied by policy"
result.success = false

// Validation failed (from DocumentWriter)
error: "write_document: title cannot be empty"
result.success = false

// Tool timeout
error: "Tool timeout after 30000ms"
result.success = false

// Tool internal error (catch-all)
error: "Tool error: [underlying error message]"
result.success = false
```

#### Integration Points

- **Ticket 002**: Executor calls DocumentWriter.writeDocument()
- **Ticket 008**: Executor calls DocumentReader.queryDocuments()
- **Ticket 004**: Executor returns ToolResultEnvelope with metrics
- **Ticket 005**: Error classification per taxonomy
- **Ticket 006**: Config provides tool options (timeout, base dir)
- **Agent loop**: Dispatcher integration (this ticket)

#### Decisions Made

- ✅ **Registry pattern**: Simple Map-based registry, register at startup
- ✅ **No tool chaining**: Each tool executes independently
- ✅ **Timeout per tool**: Default 30s, overridable
- ✅ **Metrics on every result**: Even failures include startTime, durationMs, resultSizeBytes
- ✅ **Permission check hook**: Optional, for future extension (Ticket 039)
- ✅ **Never throw**: All errors in envelope, agent loop never sees exceptions

#### Open Questions (Time-boxed or Future)

- **Dynamic tool loading**: Should tools be loaded from plugins/files instead of hardcoded? → **Future (plugin system).**
- **Tool versioning**: How do we handle breaking changes to tool interfaces? → **Future (tool versioning).**
- **Concurrent tool execution**: Should multiple tools run in parallel? → **Future (only safe for read-only tools; would require partitioning).**
- **Tool dependency injection**: Should tools declare dependencies (e.g., "I need config")? → **Future (advanced DI).**

#### Validation & Closure

This implementation plan establishes:
- ✅ ToolRegistry pattern for registration and lookup
- ✅ ToolExecutor with request → execution → envelope flow
- ✅ Timeout handling (default 30s per tool)
- ✅ Permission check hook (for future security, ticket 039)
- ✅ Metrics capture on all results
- ✅ Error classification per Ticket 005
- ✅ Agent loop integration explicit
- ✅ Initialization pattern clear (setup at startup)

**Ticket 009 is now closed.**
