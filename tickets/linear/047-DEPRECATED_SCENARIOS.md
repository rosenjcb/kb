# Deprecated Scenarios (Ticket 047)

These scenarios were designed for **Option A (unified `write_document` with `operationMode`)**, which was deprecated in favor of **Option B (specialized tools)**.

## Why Deprecated

- **Decision**: Chose Option B (specialized tools) after reviewing `claude-code` codebase pattern
- **Reasoning**: Separation of concerns is clearer; tool names document intent; teams already follow this pattern (FileReadTool vs FileEditTool, TaskCreateTool vs TaskUpdateTool)
- **Implementation impact**: Instead of `write_document(operationMode="merge")`, agents now call `merge_documents(...)` directly
- **Migration**: All valid scenarios reimplemented in ticket 047 main plan using specialized tools

## Deprecated Scenario A (Archived)

**Old Design (Option A):**
```typescript
// ❌ Old: operationMode parameter
Agent calls: write_document({
  documentId: "decision-log-2024",
  operationMode: "append",  // ← operationMode enum
  content: "### Q3: Migrate to turborepo",
  type: "decision"
})
```

**New Design (Option B):**
```typescript
// ✅ New: specialized append_to_document tool
Agent calls: append_to_document({
  documentId: "decision-log-2024",
  content: "### Q3: Migrate to turborepo for monorepo builds"
})
```

**Why changed**: `append_to_document` name is self-documenting; no need to read docs to understand intent.

---

## Deprecated Scenario D: Type-Aware Operation Defaults (Archived)

**Old Design: operationMode depended on document type**

The idea was that different document types would have different default operations:

```typescript
// ❌ Old design: type determines default operationMode
- Architecture doc (type="architecture"): 
  - Default operation: operationMode="replace"
  - Reason: Architectures are versioned, not incremental

- Decision doc (type="decision"): 
  - Default operation: operationMode="append"
  - Reason: Decisions are immutable log

- Checklist (type="checklist"): 
  - Default operation: operationMode="append"
  - Reason: Items added to list
```

**Why Deprecated:**

With **Option B (specialized tools)**, type-aware defaults are no longer needed because:

1. **Tool name is explicit**: If an agent calls `append_to_document`, it's appending. No defaults needed.
2. **Type metadata is still useful**: Document type (in YAML frontmatter) can still inform agent behavior, but through tool choice, not operationMode defaults.
3. **Agent logic becomes clearer**: "If this is a decision log, use append_to_document" is more readable than "if type=decision, set operationMode=append".

**Migration:**

Agent logic moves from:
```typescript
// ❌ Old: Rely on type defaults
write_document({ documentId, content, type: "decision" })
// System infers: operationMode="append" because type="decision"
```

To:
```typescript
// ✅ New: Agent explicitly chooses tool based on type
if (docType === "decision") {
  append_to_document({ documentId, content });  // Intent clear
} else if (docType === "architecture") {
  update_document({ documentId, content });     // Intent clear
}
```

**Benefit**: No implicit defaults; agent code documents its own logic.

---

## When to Reference These

- If implementing migration tools (converting old Notion/code that relied on operationMode)
- If explaining why separation of concerns won (Option B over Option A)
- If training agents on "why not do X" anti-patterns
