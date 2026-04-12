# Freeze violation schema contract v1

## Ticket ID
003

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

### Violation Schema (Ephemeral Mismatch Reports)

#### Background
When the KB agent compares actual code/state to KB documents, it discovers inconsistencies (violations) and knowledge gaps. These mismatches need a stable schema for reporting, logging, and agent decision-making. Violations are **ephemeral**—they're discovered at query time or during audits, and may persist indefinitely if not addressed (e.g., if someone pushes code without updating KB docs).

#### Approach
Define a minimal violation record that captures the mismatch type (inconsistency vs knowledge_gap), severity, evidence, and requester actions. Violations are NOT persisted in the KB by default; they're reported in real-time. A separate ticket will define audit logging if needed.

#### Examples / Specifications

**Type Definitions:**

```typescript
type ViolationType = 'inconsistency' | 'knowledge_gap'

type ViolationSeverity = 'critical' | 'warning' | 'info'

interface Violation {
  id: string                        // Auto-generated ULID for this violation report
  type: ViolationType              // 'inconsistency' or 'knowledge_gap'
  severity: ViolationSeverity      // critical | warning | info
  documentId?: string              // Which KB doc is involved (if applicable)
  title: string                    // Human-readable mismatch title
  description: string              // Detailed explanation of the violation
  evidence: {
    kbState: string                // What KB says (quote or summary)
    actualState: string            // What code/system actually does
    mismatchReason: string         // Why they don't match
  }
  detectedAt: string               // ISO 8601 timestamp when violation was found
  requesterActions: string[]       // Concrete steps to fix (e.g., "Update doc/xyz.md", "Run tests")
  metadata?: {
    filePath?: string              // Where in codebase the mismatch was found
    codeSnippet?: string           // Optional code excerpt as evidence
    tags?: string[]                // e.g., ["architecture", "auth", "urgent"]
  }
}

interface ViolationReport {
  violations: Violation[]
  summary: {
    total: number
    bySeverity: { critical: number; warning: number; info: number }
    byType: { inconsistency: number; knowledge_gap: number }
  }
  reportedAt: string               // ISO 8601 timestamp when report was generated
  reportedBy: string               // E.g., "kb-agent" or "claude"
}
```

**Example Violation 1: Inconsistency (Code-vs-KB mismatch)**

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "type": "inconsistency",
  "severity": "critical",
  "documentId": "01AS9Z5QERF3N4YD6JK9L2WX",
  "title": "Auth mechanism mismatch",
  "description": "KB doc '001-kb-mission-and-scope.md' states auth uses JWT, but src/auth/index.ts uses Basic auth with header validation.",
  "evidence": {
    "kbState": "We use JWT for session tokens and validate against Redis cache.",
    "actualState": "Authorization header is parsed as 'Basic <base64>' and validated against a hardcoded admin list.",
    "mismatchReason": "KB documentation is stale; code was updated 3 months ago without KB update."
  },
  "detectedAt": "2026-04-12T14:35:22Z",
  "requesterActions": [
    "Review src/auth/index.ts to understand current auth flow",
    "Update KB document 'Authentication Architecture Decision' with current implementation",
    "Add details: Basic auth flow, admin list location, migration plan to JWT"
  ],
  "metadata": {
    "filePath": "src/auth/index.ts",
    "codeSnippet": "const auth = req.headers.authorization?.split(' ')[1]; // Basic auth",
    "tags": ["architecture", "auth", "critical"]
  }
}
```

**Example Violation 2: Knowledge Gap (Missing KB documentation)**

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ70G5FAW",
  "type": "knowledge_gap",
  "severity": "warning",
  "documentId": null,
  "title": "Deployment constraints not documented",
  "description": "src/deploy/constraints.ts defines node version, memory, and region requirements, but KB has no document explaining deployment model.",
  "evidence": {
    "kbState": "No existing KB document on deployment constraints or infrastructure requirements.",
    "actualState": "Code enforces: Node 20+, 4GB RAM, us-east-1 region; fallback to us-west-2.",
    "mismatchReason": "Knowledge exists only in code; not captured in KB for agents to reference."
  },
  "detectedAt": "2026-04-12T14:35:22Z",
  "requesterActions": [
    "Create new KB document: 'Deployment Model and Constraints'",
    "Document: Node version requirements, memory allocation, region preferences, fallback strategy",
    "Tag with: deployment, infrastructure, constraints"
  ],
  "metadata": {
    "filePath": "src/deploy/constraints.ts",
    "codeSnippet": "const MIN_NODE_VERSION = 20; const MIN_MEMORY_GB = 4;",
    "tags": ["infrastructure", "missing", "warning"]
  }
}
```

**Example Violation 3: Knowledge Gap (Implicit permission not documented)**

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ71G5FAX",
  "type": "knowledge_gap",
  "severity": "info",
  "documentId": null,
  "title": "Tool permission rules exist only in code",
  "description": "business/permissions.yaml is incomplete; tool-specific deny patterns are hard-coded in src/tools/executor.ts.",
  "evidence": {
    "kbState": "business/permissions.yaml lists role-based access but omits denial patterns.",
    "actualState": "src/tools/executor.ts enforces additional deny rules for patterns like 'admin_*' and 'internal_*'.",
    "mismatchReason": "Permission rules are split across two locations; KB is not the single source of truth."
  },
  "detectedAt": "2026-04-12T14:35:22Z",
  "requesterActions": [
    "Review src/tools/executor.ts to extract all deny patterns",
    "Consolidate into business/permissions.yaml or create KB doc: 'Permission Evaluation Order'",
    "Ensure agents can query single location for complete permission model"
  ],
  "metadata": {
    "filePath": "src/tools/executor.ts",
    "tags": ["permissions", "governance", "incomplete"]
  }
}
```

#### Request/Response Flow (via MCP tool)

**Agent asks KB to check for violations:**

```json
{
  "name": "check_kb_sync",
  "input": {
    "scope": "full",
    "severityThreshold": "warning"
  }
}
```

**KB responds with violation report:**

```json
{
  "violations": [
    { /* violation 1 */ },
    { /* violation 2 */ },
    { /* violation 3 */ }
  ],
  "summary": {
    "total": 3,
    "bySeverity": { "critical": 1, "warning": 1, "info": 1 },
    "byType": { "inconsistency": 1, "knowledge_gap": 2 }
  },
  "reportedAt": "2026-04-12T14:35:22Z",
  "reportedBy": "kb-agent"
}
```

#### KB Agent Loop (High-Level)

```
Input: Agent questions or manual audit trigger
  ↓
Agent reads KB documents (via query)
  ↓
Agent scans codebase for relevant code (e.g., find src/auth/*)
  ↓
Agent LLM compares KB state vs code state
  ↓
Agent generates Violation records for each mismatch
  ↓
Agent returns ViolationReport
  ↓
Requester (Claude or human) reads requesterActions and remedies
```

#### Error Conditions & Edge Cases

| Condition | Response |
|-----------|----------|
| No violations found | Return `violations: []` with summary counts all zero |
| KB document missing | Set `documentId: null`, type: `knowledge_gap` |
| Code file not found | Include `filePath` but set `codeSnippet` to null; note in description |
| Agent LLM fails to parse code | Return violation with severity `info`, note unreliability in description |
| Scope too large (full audit > 30s) | Return partial results + `truncated: true` in metadata |

#### Decisions Made
- ✅ **Violation Types**: `inconsistency` (KB ≠ Code) and `knowledge_gap` (KB missing info)
- ✅ **Severity**: critical, warning, info (allows filtering and prioritization)
- ✅ **Ephemeral**: Not persisted by default; reported at query time or audit trigger
- ✅ **Evidence Structure**: Explicit kbState, actualState, mismatchReason (clear for agents)
- ✅ **Requester Actions**: Concrete next steps (agent responsibility to suggest fixes)
- ✅ **Document Reference**: Optional `documentId` (null for knowledge_gaps with no existing doc)

#### Integration Points
- Ticket 002 (DocumentWriter) defines how KB docs are created; Violations reference them.
- Ticket 018 (MCP tool: docsync_check) will use this schema to report violations.
- Ticket 027 (Compare prompt) will define how KB agent detects mismatches (prompt + schema used for LLM validation).
- Ticket 028 (Violation normalization) will define rules for de-duplication and aggregation if violations are logged.

#### Open Questions (Time-boxed or Future)
- **Persistence**: Should violations be logged to a `violations.jsonl` for audit trail? → **Future ticket (ticket 033: Observability event catalog).**
- **Auto-remediation**: Should KB agent suggest code patches to fix violations? → **Future ticket (code generation layer).**
- **Severity assignment**: Currently manual; could we infer severity from code impact analysis? → **Future ticket (risk scoring).**
- **Batch violation reports**: How do we handle 100+ violations in one scan? → **Future ticket (batching and pagination).**

#### Validation & Closure
This implementation plan establishes:
- ✅ Violation schema with type, severity, evidence, and requester actions
- ✅ Two violation types: inconsistency (mismatch) and knowledge_gap (missing documentation)
- ✅ Ephemeral lifecycle: discovered at query/audit time, not persisted unless audit ticket implements logging
- ✅ KB agent loop sketch: read KB → scan code → compare → generate violations
- ✅ Integration with MCP tools (ticket 018 will consume this schema)
- ✅ Extension points clear (audit logging, auto-remediation, severity inference in future)

**Ticket 003 is now closed.**
