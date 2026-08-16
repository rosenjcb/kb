---
name: spec-md
description: Author or update a *.spec.md file — an Open Knowledge Format spec that captures a system's intent, behavior, and verification so both humans and agents stay aligned. Produces OKF metadata, Intro, Definitions, Scope, Functional Requirements (FR-N), and QA Test Cases with stable TC-XXXX ids. Also creates and manages the optional *.review.md sign-off record (stakeholder roles, per-role briefings, approval state).
---

# spec-md

Write a `*.spec.md` file: the authoritative, living description of a system —
what it does, why it exists, and how it must behave. A spec is shared context
for Product, Engineering, QA, and agents. It uses the
[spec-md](https://github.com/rosenjcb/spec.md) format, an Open Knowledge Format
extension, so it stays machine-readable and stays synchronized with the system
it describes.

## When to use

- A feature or domain has behavior worth pinning down before (or while) it is built
- QA reports failures and you must formalize what "correct" means
- Code exists, but no spec traces intent to implementation and tests
- You must align engineering and QA on expected behavior before release
- A spec needs stakeholder sign-off, or a sign-off occurred and the
  review record must be updated

## Step 0: Triage

Before you change files, settle two questions. Classify them from the user's
request and the state of the repo when the signal is clear. Ask one or two
questions — not a quiz — only when it is not.

1. **Create or update?** Look before you ask: a `*.spec.md` already covers
   the domain → update it (Step 1, then **Step 2u**). None → create one
   (Step 1, then Step 2). The other steps (3–5) apply to both.
2. **Does it need a review?** Judge the scale of the request:
   **ambiguity** (can two reasonable people build different things?),
   **impact** (how much inherits a mistake?), and **stakeholder
   spread** (must anyone outside the PR agree?). Small and
   unambiguous → no review; say so and continue. Clearly risky or
   cross-team → plan a review record (Step 5) and confirm who is involved.
   Genuinely unclear → ask the user.

Decide about the review **here, at the start**. Write the record itself in
Step 5, when there is a spec to derive it from.

Two id rules stay in force for the life of a spec:

1. **`FR-N` ids stay contiguous and ascending** — `FR-1..FR-n` in table order,
   with no gaps. The default edit appends `n + 1`. If you reorder FR rows,
   renumber them `1..n` in the new order.
2. **Each test-case id is a stable opaque join key** in the form
   `TC-[A-Z0-9]{4}` (for example `TC-K7MF`). It identifies the test case, not
   its row position. Generate a new id with `spec-md id` (or the shared id
   helper). Never choose an id from row position. Never renumber, reuse, or
   recompute an existing TC id when its text changes. Gaps and reorder are
   fine — they are not missing tests.

`spec-md lint` enforces both rules.

## Step 1: Gather context

Derive the spec from the real system. Do not invent structure.

1. **Read the code.** Branching logic, validation, and lifecycle states become
   your Functional Requirements and the dimensions your Test Cases must cover.
2. **Read existing docs.** Tickets, `.context.md`, prior specs, e2e cases.
3. **Locate `sources` and `tests`.** Find which paths implement the spec, and
   which prove it. These become metadata.
4. **When you update, read the current spec first.** Compare its claims against
   the code and the tests as they are now. Note what drifted: new behavior with
   no `FR-N`, requirements whose behavior changed, TC rows that no longer
   match, and tests with no row (or rows with no test).
5. **Ask only when blocked.** One or two questions at a time. Show what you
   found in the code, then confirm it.

## The language: Simplified Technical English

Write the spec in **ASD-STE100 Simplified Technical English** (STE), the
controlled-English standard from aerospace maintenance documentation. A spec is
read by product, engineering, QA, agents, and frequently by people who do not
speak English as a first language. STE removes the ambiguity that makes those
readers build different things. Six rules do most of the work:

1. **One idea per sentence.** Keep requirements and instructions to 20 words or
   fewer, descriptive text to 25 or fewer.
2. **Active voice, simple tense.** Write "the API rejects the request", not
   "the request will have been rejected".
3. **One word, one meaning.** Use the same name for the same thing every time.
   An `order` is always an order, never a "purchase" or a "transaction".
4. **No `-ing` forms**, unless the word is a technical name (`routing key`).
   Write "when the customer submits the order", not "on submitting the order".
5. **Plain words.** Prefer the short, common word: `use`, not `utilize`;
   `start`, not `initiate`; `about`, not `with regard to`.
6. **No idiom, metaphor, or humor.** They do not translate, and an agent reads
   them as fact.

| Instead of | Write |
|------------|-------|
| Orders that have been submitted are subsequently priced by the pricing engine utilizing the applicable multipliers. | The pricing engine prices a submitted order. It multiplies the base price by the size multiplier. |
| Prevent post-creation mutation of the order aggregate. | Do not let a user change an order after the system creates it. |
| Handle bad input gracefully. | Reject a request that has no `customerId`. Return status 400. |

Apply this to every part of the document: Intro, Definitions, Scope, `FR-N`,
test cases, and the review briefings in Step 5. The full dictionary and all 65
rules are in the standard itself ([asd-ste100.org](https://www.asd-ste100.org/));
the six rules above are what a spec needs each day.

## Step 2: Write the spec (create)

Naming: `<domain>.spec.md` (e.g. `order.spec.md`). Put it where it fits the
project — next to the code it describes (`src/orders/order.spec.md`) or in a
specs directory. The location does not matter, because `sources` and `tests`
are relative to the spec file. Set those paths to match the location you chose.
Keep every section short. **The rule: filler makes a reader skim, and a spec
that readers skim aligns nobody.** Write a short spec that links to deeper
material ([TESTING.md](./TESTING.md), [REVIEW.md](./REVIEW.md), examples).
Do not paste checklists into it or repeat a companion document.

### Metadata (frontmatter)

Only `type` and `title` are required. Add the other keys as the spec matures.

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
| `type` | **Yes** | Always `Spec` for a `*.spec.md` document. |
| `title` | **Yes** | Human-readable name. |
| `sources` | No | YAML list of **spec-relative** paths to code/schemas/docs that implement the spec. |
| `tests` | No | YAML list of spec-relative paths to verification (unit suites, `.http`, e2e). |
| `description` | No | One-line summary. |
| `resource` | No | External URL where the spec is published or synchronized. |
| `review` | No | Spec-relative path to the sign-off record (see Step 5). |
| `tags` | No | Freeform labels for grouping. |
| `timestamp` | No | ISO 8601 time of the last update. |

`sources` is *what the system does*. `tests` is *what proves it*. Both are
YAML lists of paths relative to the spec file, so the spec stays portable.
Omit either key if it does not exist yet.

### Intro

One or two paragraphs: the purpose of the system, its role as system of record,
and its lifecycle boundaries. State what is immutable and what flows downstream.

### Definitions

Shared vocabulary for the spec. Define only terms specific to this system, or
terms that are ambiguous without a definition. Include the field name where it
helps (`customerId`, `basePrice` in cents).

```md
### Definitions

- Order: A completed purchase transaction, identified by `id`.
- Order Total: The final amount after discounts, taxes, and adjustments, in cents.
- Status: The lifecycle state (CREATED, PAID, FULFILLED, REFUNDED).
```

### Scope

Two lists, under `## In Scope` and `## Out of Scope`. This prevents drift in
responsibility, so be explicit about what the system does *not* own.

### Functional Requirements

A table of `FR-N` rows. Each row is a **higher-level, testable** statement of
intent. It is not a vague goal, and it is not an implementation detail. Write
one behavior per row, in the active voice, in 20 words or fewer.

```md
### Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Create an order from a request that has a customer and one item or more |
| FR-2 | Calculate each line total and the order total from the price and the size multiplier |
| FR-3 | Reject each change to an order after the system creates it |
| FR-4 | Reject a request that has no customer or has an invalid item |
```

### QA Test Cases

A table of test-case rows. Each row has a **stable opaque Test ID**
(`TC-XXXX`) and cites the `FR-N` it proves. A Test ID is a stable join key
between the QA row and the tests that prove it. It is not a sequence number.
Usually **several** test cases prove one FR (for example, pricing needs a case
for size, one for quantity, and one for rounding). Each row is a deterministic,
concrete check with an exact input and an exact expected outcome.

Generate each new id with the tooling — do not invent `TC-1`, `TC-2`, and so on:

```bash
spec-md id --requirement FR-4 --scenario "The request has no customerId"
# → TC-ZFJF (example; the real value is content-derived)
```

```md
### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-K7MF | FR-1 | The customer submits a valid request | The system creates the order with status CREATED |
| TC-2QXR | FR-2 | The customer orders a large pizza | The unit price is the base price × 1.6, rounded to the cent |
| TC-8PDA | FR-4 | The request has no `customerId` | The API returns status 400 |
| TC-V4WN | FR-4 | The `items` list is empty | The API returns status 400 |
```

Cover the happy path first, then the edge cases, then the error conditions.
Group related cases under the FR they belong to. Row order is for readers only;
it does not change the ids. Be concrete: `[owner, downlineA, unrelated]` is
better than "a mixed array".

## Step 2u: Update the spec

Edit the existing file in place. Keep the prose and the ids that are still
correct, and change only what drifted. Apply the same section rules as Step 2,
and these rules also:

- **FR ids stay contiguous and ascending.** The FR table must be exactly
  `FR-1..FR-n` in row order, with no gaps. If not, `spec-md lint` fails.
- **TC ids stay stable.** A Test ID is permanent for the life of that case.
  Reorder rows freely. Delete a row without renumbering anything else. Never
  change an id because its scenario text changed. Never treat a "gap" between
  opaque ids as a missing test.
- **Default: append.**
  - A new **FR** takes `n + 1` and goes at the end of the FR table.
  - A new **TC** gets a fresh id from `spec-md id` (or the shared helper), with
    the already-used ids of that spec passed so collisions resolve, and goes
    at the end of the TC table (or wherever it reads best).
- **Clean up after each FR reorder only.** If FR rows have gaps or are out of
  order: reorder them, renumber `FR-1..FR-n`, and leave every TC id alone
  (update only the Requirement column if a FR number moved).
- **Edit a TC row in place** when the behavior changed but the case is the
  same. Update the text of the row, **not** its Test ID. Do not run id
  generation again for an existing row.
- **Delete a row that no longer applies.** Do not leave ghost rows or
  changelog-style tags in the table. Git history is the delta. Delete the
  matching `[TC-XXXX]` tests in the same change. Do **not** renumber other
  TC ids.
- **Do not annotate rows with lifecycle tags** such as `[NEW]`, `[UPDATED]`,
  or `[REMOVED]`. The table is the current contract only. Review deltas live
  in the PR and, when you need a formal sign-off, in the `*.review.md` briefings.
- **Reconcile the metadata.** Update `sources` and `tests` if the paths moved,
  and always set `timestamp` to the current time.
- **Lint at the end.** Run `spec-md lint` (or `check`) on the file. Correct
  each FR sequence error, bad TC format, duplicate id, and dangling reference
  before you call the update done. For a legacy numeric table, run
  `spec-md migrate-ids` once rather than editing ids by hand.

## Step 3: Link the tests

A test traces back to the spec through a bracketed `[TC-XXXX]` prefix in the
test name. The tag is the join key between the spec and the suite. See
[TESTING.md](https://github.com/rosenjcb/spec.md/blob/main/TESTING.md) for the
full convention.

```ts
it("[TC-8PDA] Given a request with no customerId, when the store creates the order, then it throws a ValidationError", () => { ... });
```

Coverage is greppable: each Test ID in the spec must have one `[TC-XXXX]` test
or more. A test with no matching row is a signal to add the TC row. If the
test is not an acceptance criterion, tag it `[smoke]` instead.

## Step 4: Flag gaps

- Mark ambiguous behavior with `??` and tell the user about it.
- Record each known difference between the code and the spec in a short
  "Known issues" section.
- Flag each `FR-N` with no TC row, and each TC with no `[TC-XXXX]` test.
- Flag duplicate ids, malformed TC format, and FR rows that are out of order.
  To correct FR order: reorder and renumber `FR-1..FR-n`. Do not renumber TC
  ids.

## Step 5: The review record (only if triage says so)

Step 0 settled whether a review is necessary. Most specs need none. If that was
the answer, stop here and create no record. The full convention is
[REVIEW.md](https://github.com/rosenjcb/spec.md/blob/main/REVIEW.md).

If a review is necessary, create `<domain>.review.md` next to the spec, and
link the two documents:

1. Ask who holds each role — driver, approver (ideally one), contributors, and
   informed. Also ask for the mode (`notice` or `signoff`), the milestone
   (`kickoff`, `pre-build`, or `pre-release`), and a deadline.
2. Write the frontmatter of the record: `type: Review`, `title`,
   `spec: ./<domain>.spec.md`, `revision` (the current commit of the spec),
   the roles, and the deadline. For a `signoff`, add `status: open`. A `notice`
   has nothing to approve and omits `status`. Add
   `review: ./<domain>.review.md` to the frontmatter of the spec.
3. Write the body: one instruction paragraph that states the goal, a roles
   table (with checkboxes for the approvers only), and a **briefing for each
   stakeholder**. Write each briefing for the role and the concerns of that
   person, derive it from the spec, and cite the sections and the
   `FR-N` / Test ID rows that it summarizes. Never write a restatement by hand,
   and never give a person a generic link to a section.

**Never set `status: approved` yourself.** The record stays `open` until the
user says that the sign-off occurred. Then check the approver boxes with dates,
write the **Outcome** line, set `status: approved`, and set a new `timestamp`
on the record. If the stakeholders declined the review, set `status: rejected`
and record why.

When you update a spec that links an approved review, ask whether the change
needs a new review. If it does, write the record again in place: a new
`revision`, `status: open`, and new briefings that cover the delta by
`FR-N` / Test ID. Git history keeps the old round, so do not append rounds to
the file.

Hand-off is manual by design. The record is one document, so give the
stakeholders that document — a link to the file or to its `resource` mirror,
through Slack or email. Do not build or configure notification machinery.

## Principles

- **Simplified Technical English.** One idea per sentence, active voice, plain
  words, and the same term for the same thing every time. See
  [The language](#the-language-simplified-technical-english).
- **Short first, deep later.** More prose makes a reader skim, and a spec that
  readers skim aligns nobody. Keep the `*.spec.md` short: intent, scope,
  `FR-N`, and TC rows. Link out for depth — [TESTING.md](./TESTING.md),
  [REVIEW.md](./REVIEW.md), examples — instead of a pasted checklist or a
  repeat of a companion document. Each layer earns its place, and nothing
  repeats the layer above it.
- **Derive from the code.** If the code branches on it, a requirement and a
  test case must cover it, and that includes null and unknown values.
- **Concrete, not abstract.** Give the exact input and the exact output, not a
  description of them.
- **Intent, not implementation.** Describe *what* must happen, never *how* the
  code does it.
- **Living, not fixed.** Give enough detail to remove ambiguity, but not so
  much rigidity that the spec goes stale. Update `timestamp` and the related
  rows as the system changes, instead of a rewrite of the whole document.
- **Stable test identity.** A Test ID (`TC-XXXX`) is a permanent join key.
  Preserve it when you edit, move, or reorder a case. Generate a new id only
  for a new case. FR rows stay `FR-1..FR-n`. Lint is the gate.
