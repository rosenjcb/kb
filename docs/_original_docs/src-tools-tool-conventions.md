---
layout: default
title: src/tools/TOOL_CONVENTIONS.md
date: '2026-05-08'
kb_id: src-tools-tool-conventions-md
tags:
  - original-source
  - src-tools-tool-conventions-md
  - kb
categories:
  - reference
---

# Tool Design Conventions

## Core Principle: Separation of Concerns

Each tool has **exactly one responsibility**. Tool names document intent. Agents and humans immediately understand what a tool does without reading parameter docs.

## Pattern: Single Responsibility Per Tool

Instead of:
```typescript
// ❌ Anti-pattern: polymorphic catch-all
write_document({
  documentId: "auth-design",
  operationMode: "merge",        // ← Which mode? Need to read docs
  mergeStrategy: "keep-target",
  content: "..."
})
```

Write specialized tools:
```typescript
// ✅ Pattern: one tool, one purpose
merge_documents({
  sourceDocId: "auth-design-v2",
  targetDocId: "auth-design-v1",
  mergeMode: "auto"
})

append_to_document({
  documentId: "decision-log",
  content: "New decision Q3..."
})

update_document({
  documentId: "runbook",
  content: "Updated steps..."
})
```

## Why This Matters

1. **Intent is self-documenting**: `merge_documents` → agent knows it's merging
2. **Fewer parameters to reason about**: Each tool does one thing well
3. **Easier to test**: Narrow contract = clear test cases
4. **Follows production precedent**: `claude-code` uses FileReadTool, FileEditTool, FileWriteTool (not polymorphic FileOperationTool)
5. **Better error messages**: Tool-specific error handling, not mode-dependent branches

## Examples from Production (claude-code)

### File Operations (3 separate tools)
- `FileReadTool`: Read files, respect line ranges, handle binary detection
- `FileEditTool`: Edit in-place with oldString/newString matching
- `FileWriteTool`: Create new files with content

Each has its own prompt, schema, validation, error handling.

### Task Operations (4 separate tools)
- `TaskCreateTool`: Create new task
- `TaskUpdateTool`: Modify existing task (status, description, owner, etc.)
- `TaskGetTool`: Fetch single task
- `TaskListTool`: Query all tasks

### Mode Tools (2 separate tools)
- `EnterPlanModeTool`: Transition to plan mode
- `ExitPlanModeTool`: Transition out of plan mode

Each operation is its own tool.

## Tool Naming Convention

Use **verb-noun** format: `{action}_{resource}`

- `write_document` ← Create new
- `append_to_document` ← Add content
- `update_document` ← Replace content
- `merge_documents` ← Consolidate two docs
- `prune_document` ← Remove sections
- `delete_document` ← Remove entirely
- `query_documents` ← Search
- `read_document` ← Fetch one

## When to Add a New Tool vs. Adding a Parameter

**Add a new tool if:**
- Different user intent (create vs. merge)
- Different error conditions or recovery paths
- Different input/output schema structure
- Tool name would describe a different action

**Add a parameter if:**
- Same core operation, different configuration
- Example: `write_document(overwrite: boolean)` — both create, but one allows collision override

## Integration Pattern

In MCP servers or CLI:

```typescript
// Register tools
const tools = [
  writeDocumentTool,
  appendToDocumentTool,
  updateDocumentTool,
  mergeDocumentsTool,
  pruneDocumentTool,
  deleteDocumentTool,
  queryDocumentsTool,
];

// Each tool has its own handler
function handleToolCall(toolName: string, input: unknown) {
  switch (toolName) {
    case 'write_document':
      return writeDocument(input);
    case 'append_to_document':
      return appendToDocument(input);
    case 'merge_documents':
      return mergeDocuments(input);
    // ... etc
  }
}
```

Each tool registers independently; no polymorphic dispatch logic.

## Documentation Requirements

For each tool, document:

1. **Purpose** (one sentence)
2. **Input schema** (Zod or JSON Schema)
3. **Output schema** (what caller receives)
4. **Error conditions** (when it fails and why)
5. **Examples** (concrete use cases)
6. **Integration points** (what other tools does it coordinate with?)

Example:

```typescript
export const mergeDocumentsTool = buildTool({
  name: 'merge_documents',
  
  description: 'Consolidate two documents into one (source merged into target).',
  
  // ... input/output schemas ...
  
  // Error conditions documented in error handling below
  async call({ sourceDocId, targetDocId, mergeMode }, context) {
    // Implementation
  }
});
```

## Review Checklist for New Tools

- [ ] Tool name clearly documents its action (verb-noun)
- [ ] One responsibility; no polymorphic modes
- [ ] Input/output schemas are focused and minimal
- [ ] Error cases are enumerated and tested
- [ ] Tool is independent (no hard dependency on another tool's output format)
- [ ] Config/permissions are tool-specific
- [ ] Examples exist for common use cases
- [ ] Promise: "If I see this tool name, I immediately know what it does"

## KB Cleanup Boundary

For KB maintenance tools that mutate stored knowledge (for example `invalidate_fact` / `kb invalidate`):

- Scope must be limited to the active KB store, not arbitrary repo files.
- SQLite-backed KB actions should read and write through the KB storage layer (`documents`, `chunks`, and related index updates), not filesystem globs.
- Source code, tests, and unrelated repo assets are out of scope unless a separate code-editing command explicitly owns that responsibility.
- CLI wording should make this explicit: these are knowledge-base cleanup operations, not codebase refactors.

## Future Evolution

As tools grow complex, consider:

1. **Composition**: Tool A calls tool B internally (still separate)
   ```typescript
   // Inside mergeDocuments:
   const sourceDoc = await queryDocuments({ id: sourceDocId });
   const targetDoc = await queryDocuments({ id: targetDocId });
   // ... merge logic ...
   await updateDocument({ documentId: targetDocId, content: merged });
   ```

2. **Specialization**: Break one tool into multiple if it gains distinct responsibilities
   ```typescript
   // If merge grows merge-with-conflict-resolution logic:
   // Split into mergeDocuments + resolveDocumentConflict
   ```

3. **Layering**: Build higher-level workflows from single-purpose tools
   ```typescript
   // Agent layer calls: merge → update → notify
   // Each tool is simple; workflow is in agent
   ```

## See Also

- Ticket 047: Document operation semantics and merging strategy
- Ticket 004: Tool invocation envelope spec
- Ticket 018: MCP tool contract spec
