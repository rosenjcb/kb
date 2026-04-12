# Specify markdown naming and collision policy

## Ticket ID
008

## Theme
local-kb

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
007

## Deliverables
- Final markdown spec in this file.
- Brief engineering handoff notes.

## Estimate
M

## Priority
TBD

---

## Implementation Plan

### Markdown Document ID Naming and Collision Rules (v1)

#### Background
The local markdown KB persists one document per file under `sessions/documents` (or namespace/base-dir override). For deterministic retrieval and safe writes, we need explicit rules for how IDs (file names) are derived and how collisions are resolved.

#### Approach
Use a slug-first naming strategy with deterministic sanitation and bounded length. On collision, support two explicit behaviors: overwrite existing file when requested, or create a unique suffix variant when overwrite is disabled. This matches current `MarkdownMDWriterTool` behavior and keeps v1 simple, transparent, and git-friendly.

#### Examples / Specifications

**Primary naming source**

1. If `documentId` is provided, derive file id from `documentId`.
2. Else, derive file id from `title`.
3. Resulting filename is `{id}.md`.

**Sanitization rules**

Given input string `value`, compute `id` as:

```text
id = value
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, '-')
	.replace(/^-+|-+$/g, '')
	.slice(0, 80)

if id is empty, fallback to "document"
```

Examples:

- `"API Design v2"` -> `api-design-v2`
- `"  ***  "` -> `document`
- `"Very Long Title ..."` -> first 80 chars after sanitation

**Collision policy**

Write operation uses `id` and target path `{baseDir}/{id}.md`.

- If `overwrite=true`:
	- Write directly to `{id}.md` (replace existing content if present).
	- Returned `id` remains `{id}`.

- If `overwrite=false` (default):
	- Attempt exclusive create at `{id}.md`.
	- If file does not exist, create successfully with `id={id}`.
	- If file exists, generate unique path `{id}-{suffix}.md` where `suffix = dayjs().valueOf().toString(36)`.
	- Returned `id` is basename of actual written file, e.g. `api-design-v2-mnva9k3f`.

**Response guarantees**

`WriteDocumentResult` must reflect the actual written file:

- `id`: basename of written file
- `filePath`: absolute path to written file
- `createdAt`, `updatedAt`: write timestamp for this operation

**Index behavior**

`_table.md` index row key is the actual `id` written. Collisions resolved via suffix create distinct index rows rather than mutating existing rows.

#### Error Conditions / Edge Cases

- Non-`EEXIST` write errors during create must be surfaced as failures.
- Concurrent writers may still race between suffix generation and second write; v1 accepts low-probability collision risk and relies on timestamp entropy.
- Sanitization can map many titles to the same slug; this is expected and handled by collision policy.
- `documentId` is not treated as immutable identity in v1 when `overwrite=false`; collisions produce suffixed IDs.

#### Decisions Made

- ✅ Decided: Lowercase kebab-style slug IDs with `a-z0-9` and `-` only.
	Rationale: Portable filenames and predictable references across OSes and git diffs.
- ✅ Decided: Default collision behavior is append-only (`overwrite=false`) with timestamp suffix.
	Rationale: Safer for auditability and avoids accidental data loss.
- ✅ Decided: Explicit overwrite path (`overwrite=true`) is allowed for in-place updates.
	Rationale: Supports intentional edits without requiring new IDs.

#### User Decision Checkpoint (Required if any open question exists)

- Decision requested from user: Choose collision suffix strategy for v1.
- Options presented:
	1. Keep timestamp-base36 suffix (`dayjs().valueOf().toString(36)`) (recommended)
	2. ULID-based suffix
	3. Monotonic counter suffix
	4. Defer to v1.1 with follow-up ticket
- User response: Option 1 selected, with explicit request to use `dayjs` for all time handling.
- Follow-up: None required for v1; reassess in v1.1 if write-concurrency pressure increases.

#### Integration Points

- Depends on storage layout in ticket 007.
- Must remain compatible with index table format ticket 009.
- CLI update flows (tickets 012/013) should surface collision/overwrite outcomes clearly to users.

#### Validation & Closure
This implementation plan establishes:

- ✅ Naming derivation order and sanitation are explicit and deterministic.
- ✅ Collision handling is explicit for both default and overwrite modes.
- ✅ Result and index behavior are unambiguous for implementation and tests.

**Ticket 008 is now closed.**
