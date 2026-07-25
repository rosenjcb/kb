---
name: spec-md
description: Author or update a *.spec.md file — an Open Knowledge Format spec that captures a system's intent, behavior, and verification so both humans and agents stay aligned. Produces OKF metadata, Intro, Definitions, Scope, Functional Requirements (FR-N), and QA Test Cases (TC-N). Also creates and manages the optional *.review.md sign-off record (stakeholder roles, per-role briefings, approval state).
---

# spec.md

Write a `*.spec.md` file: the authoritative, living description of a system —
what it does, why it exists, and how it should behave. A spec is shared context
for Product, Engineering, QA, and agents, structured as a
[spec.md](https://github.com/rosenjcb/spec.md) document (an Open Knowledge Format
extension) so it stays machine-readable and synchronized with the system it
describes.

## When to use

- A feature or domain has behavior worth pinning down before (or while) it is built
- QA reports failures and you need to formalize what "correct" means
- Code exists but no spec traces intent to implementation and tests
- You need to align engineering and QA on expected behavior before release
- A spec needs stakeholder sign-off, or a sign-off was granted and the
  review record must be updated

## Step 0: Triage

Before touching files, settle two things. Classify them from the user's
request and the state of the repo when the signal is clear; ask — one or two
questions, not a quiz — only when it is not.

1. **Create or update?** Look before asking: a `*.spec.md` already covering
   the domain → update it (Step 1, then **Step 2u**). None → create one
   (Step 1, then Step 2). The rest (Steps 3–5) applies to both.
2. **Will it need a review?** Judge the scale of what is being asked:
   **ambiguity** (could two reasonable people build different things?),
   **blast radius** (how much inherits a mistake?), and **stakeholder
   spread** (does anyone outside the PR need to agree?). Small and
   unambiguous → no review; say so and move on. Clearly risky or
   cross-team → plan a review record (Step 5) and confirm who is involved.
   Genuinely unclear → ask the user directly.

The review decision is made **here, up front**; the record itself is written
in Step 5, once there is a spec to derive it from.

The critical update rule: **`FR-N` and `TC-N` ids must stay contiguous and
ascending** — `FR-1..FR-n` and `TC-1..TC-n` in table order, no skips, no
jumbled mid-table inserts. `spec-md lint` enforces this. Default edit is
append-only (`n + 1` at the end). Cleanup that reshuffles rows must renumber
`1..n` in the new order and update every matching `[TC-N]` test tag in the
same change — never leave gaps or out-of-order ids.

## Step 1: Gather context

Derive the spec from the real system — do not invent structure.

1. **Read the code.** Branching logic, validation, and lifecycle states become
   your Functional Requirements and the dimensions your Test Cases must cover.
2. **Read existing docs.** Tickets, `.context.md`, prior specs, e2e cases.
3. **Locate `sources` and `tests`.** Which paths implement the spec, which prove
   it. These become metadata.
4. **When updating, read the current spec first** and diff its claims against the
   code and tests as they are now. Note what drifted: new behavior with no
   `FR-N`, requirements whose behavior changed, `TC-N` rows that no longer match,
   tests with no row (or rows with no test).
5. **Ask only when blocked.** One or two questions at a time; present what you
   found in the code and confirm.

## Step 2: Write the spec (create)

Naming: `<domain>.spec.md` (e.g. `order.spec.md`). Place it wherever fits the
project — next to the code it describes (`src/orders/order.spec.md`) or in a
dedicated specs directory. Location does not matter; `sources` and `tests` are
relative to the spec file, so set those paths to match wherever you put it.
Keep every section tight — each sentence earns its place. **Golden rule:** the
more filler a reader must skim, the less the spec compels. Prefer a short
spec that links to deeper material ([TESTING.md](./TESTING.md),
[REVIEW.md](./REVIEW.md), examples) over pasting checklists or restating
companion docs inline.

### Metadata (frontmatter)

Only `type` and `title` are required; add the rest as the spec matures.

```yaml
---
type: Spec
title: "Spec: Orders"
sources: [./src/orders]
tests: [./test/orders, ./http/orders.http]
description: The specification for the Orders domain
resource: https://notion.com/read_only_publish_page_location
tags: [sales, orders, revenue]
timestamp: 2026-05-28T14:30:00Z
---
```

| Key | Required | Purpose |
|-----|----------|---------|
| `type` | **Yes** | Always `Spec` for a spec.md file. |
| `title` | **Yes** | Human-readable name. |
| `sources` | No | YAML list of **spec-relative** paths to code/schemas/docs that implement the spec. |
| `tests` | No | YAML list of spec-relative paths to verification (unit suites, `.http`, e2e). |
| `description` | No | One-line summary. |
| `resource` | No | External URL where the spec is published/synced. |
| `review` | No | Spec-relative path to the sign-off record (see Step 5). |
| `tags` | No | Freeform labels for grouping. |
| `timestamp` | No | ISO 8601 of last update. |

`sources` is *what the system does*; `tests` is *what proves it*. Both are
YAML lists of paths relative to the spec file, so the spec stays portable.
Omit either if it does not exist yet.

### Intro

One or two paragraphs: the system's purpose, its role as system of record, and
its lifecycle boundaries (what is immutable, what flows downstream).

### Definitions

Shared vocabulary used across the spec. Only terms specific to this system or
ambiguous without definition. Include the field name where it helps
(`customerId`, `basePrice` in cents).

```md
### Definitions

- Order: A completed purchase transaction, identified by `id`.
- Order Total: Final amount after discounts, taxes, and adjustments, in cents.
- Status: Lifecycle state (CREATED, PAID, FULFILLED, REFUNDED).
```

### Scope

Two lists under `## In Scope` and `## Out of Scope`. This prevents
responsibility drift — be explicit about what the system does *not* own.

### Functional Requirements

A table of `FR-N` rows. Each is a **higher-level, testable** statement of intent
— not a vague goal and not an implementation detail. One behavior per row.

```md
### Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Create an order from a request with a customer and at least one item |
| FR-2 | Compute line and order totals from price and size multiplier |
| FR-3 | Prevent modification of an order after creation |
| FR-4 | Reject requests missing a customer or with invalid items |
```

### QA Test Cases

A table of `TC-N` rows, each citing the `FR-N` it proves. A single FR is usually
proven by **several** test cases (e.g. pricing → size, quantity, rounding). Each
row is a deterministic, concrete check — exact input, exact expected outcome.

```md
### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-1 | FR-1 | Valid request submitted | Order created with status CREATED |
| TC-2 | FR-2 | Larger size priced | Unit price scaled by multiplier, rounded |
| TC-3 | FR-4 | Missing customerId | 400 validation error |
| TC-4 | FR-4 | Empty items list | 400 validation error |
```

Cover happy path first, then edge cases, then error conditions. Prefer writing
related cases under the FR they belong to **in the order you want them to keep**
— ids will be `TC-1..TC-n` in that table order. Be concrete:
`[owner, downlineA, unrelated]` beats "a mixed array".

## Step 2u: Update the spec

Edit the existing file in place — keep the prose and IDs that still hold, change
only what drifted. Apply the same section rules as Step 2, plus:

- **Keep ids contiguous and ascending.** Every FR/TC table must be exactly
  `FR-1..FR-n` / `TC-1..TC-n` in row order — no skips, no out-of-order rows.
  `spec-md lint` fails otherwise.
- **Default: append.** New requirements / cases take `n + 1` and go at the
  **end** of the table. Scan the table for the current count (and confirm it
  matches the highest `N`) before allocating. Never invent a mid-range id
  (`TC-84` when the table ends at `TC-4`), never reuse a live id, never copy
  an id from another spec.
- **Cleanup after every insert / remove / edit.** If rows are jumbled, skipped,
  or clustered wrong:
  1. Reorder for readability — FR by domain/lifecycle; TC by the `FR-N` they
     prove (happy → edge → error within each group).
  2. **Renumber** the table to `1..n` in that new order.
  3. Update every `[TC-N]` test tag (and any review briefings citing ids) to
     match — in the same change.
  Do not leave `TC-1, TC-2, TC-84, TC-3`. Do not renumber without updating tags.
- **Edit a row in place** when behavior changed but the requirement is the same —
  update its text, not its number (append-only path).
- **Mark removed behavior** rather than deleting silently: append `[REMOVED]` to
  the row (and remove its `[TC-N]` tests) so reviewers see the change. A
  `[REMOVED]` row still occupies its index (sequence stays contiguous). When
  nothing references it anymore, delete the row and **compact**: renumber the
  remainder to `1..n` and update tags.
- **Mark new or changed rows** with `[NEW]` or `[UPDATED]` while the change is in
  review; drop the marker once merged.
- **Reconcile metadata.** Update `sources`/`tests` if paths moved, and always
  bump `timestamp` to the current time.
- **Finish with lint.** Run `spec-md lint` (or `check`) on the file and fix any
  sequence / duplicate / dangling-reference errors before considering the
  update done.

## Step 3: Link the tests

Tests trace back to the spec via a bracketed `[TC-N]` prefix on the test name —
the join key between spec and suite. See
[TESTING.md](https://github.com/rosenjcb/spec.md/blob/main/TESTING.md) for the
full convention.

```ts
it("[TC-3] Given a request without a customerId, when the order is created, then a ValidationError is thrown", () => { ... });
```

Coverage is greppable: every `TC-N` in the spec should have at least one
`[TC-N]` test. A test with no matching row is a signal to add the `TC-N` — or
tag it `[smoke]` if it is not an acceptance criterion.

## Step 4: Flag gaps

- Mark ambiguous behavior with `??` and call it out.
- Note known mismatches between code and spec in a short "Known issues" section.
- Flag any `FR-N` with no `TC-N`, and any `TC-N` with no `[TC-N]` test.
- Flag duplicate ids, skipped numbers, or out-of-order FR/TC rows — fix by
  reordering then renumbering `1..n` and updating `[TC-N]` tags before finishing.

## Step 5: The review record (only if triage said so)

Whether a review is needed was settled in Step 0 — most specs need none; if
that was the answer, stop here and create no record. The full convention is
[REVIEW.md](https://github.com/rosenjcb/spec.md/blob/main/REVIEW.md).

If a review is needed, create `<domain>.review.md` next to the spec and
link the two:

1. Ask who holds the roles — driver, approver(s) (ideally one),
   contributors, informed — plus the mode (`notice` or `signoff`), the
   milestone (`kickoff`, `pre-build`, `pre-release`), and a deadline.
2. Write the record's frontmatter: `type: Review`, `title`,
   `spec: ./<domain>.spec.md`, `revision` (the spec's current commit), the
   roles, the deadline — and, for a `signoff`, `status: open`. A `notice`
   has nothing to approve and omits `status`. Add
   `review: ./<domain>.review.md` to the spec's frontmatter.
3. Write the body: an instruction paragraph stating the goal, a roles table
   (checkboxes for approvers only), and a **briefing per stakeholder** —
   written for that person's role and concerns, derived from the spec,
   citing the sections and `FR-N`/`TC-N` rows it summarizes. Never
   hand-author restatements; never hand someone a generic section link.

**Never set `status: approved` yourself.** The record stays `open` until
the user says sign-off actually happened. Then: check the approver boxes
with dates, write the **Outcome** line, flip `status: approved`, and bump
the record's `timestamp`. If the review was declined, set
`status: rejected` and record why.

When updating a spec that links an approved review, ask whether the change
warrants re-review. If it does, regenerate the record in place — new
`revision`, `status: open`, fresh briefings covering the delta by
`FR-N`/`TC-N` id. Git history keeps the old round; do not append rounds to
the file.

Hand-off is manual by design: the record is one document, so give
stakeholders the document — a link to the file or its `resource` mirror,
over Slack or email. Do not build or wire up notification machinery.

## Principles

- **Succinct, then deeper.** More prose a reader must wade through, less likely
  they are compelled by the spec. Keep the `*.spec.md` short: intent, scope,
  `FR-N`, `TC-N`. Link out for depth — [TESTING.md](./TESTING.md),
  [REVIEW.md](./REVIEW.md), examples — instead of pasting checklists or
  restating companion docs. Each layer earns its place; nothing repeats what
  the layer above already said.
- **Derive from the code.** If the code branches on it, a requirement and a test
  case should cover it — including null/unknown values.
- **Concrete over abstract.** Exact inputs and outputs, not descriptions of them.
- **Intent, not implementation.** Describe *what* should happen, never *how* the
  code does it.
- **Living, not frozen.** Enough detail to remove ambiguity, not so much rigidity
  that it goes stale. Update `timestamp` and the relevant rows as the system
  evolves rather than rewriting wholesale.
- **Table hygiene.** After every insert, remove, or edit: tables must stay
  `FR-1..FR-n` / `TC-1..TC-n` ascending with no skips. Reorder for readability,
  then renumber and update `[TC-N]` tags when needed. Lint is the gate.
