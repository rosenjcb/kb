---
type: Spec
title: "Spec: Neural embeddings backend"
sources:
  - ./embeddings.ts
  - ../ops/init-cli.ts
  - ../ops/auto-sync.ts
  - ../tools/sqlite-kb-index.ts
tests:
  - ../../../../tests/core/embeddings.test.ts
description: >-
  How KB selects the embedding backend, when builds must succeed, and how
  Gemini requests obey rate and quota limits.
tags: [embeddings, gemini, onnx, init, index]
timestamp: 2026-08-10T08:00:00Z
---

### Intro

Neural embeddings power the hybrid retrieval neural lane. Index builds must
finish with real vectors for the configured backend. The builder and the
serving node must share the same backend so query vectors match stored
`model_id` rows. Local ONNX is the default. Production Fly uses Gemini to avoid
OOM on large cold builds.

Companion detail: [facts-architecture.md](./facts-architecture.md),
[INIT.md](./INIT.md), [FLY_ORCHESTRATION.md](../../../../FLY_ORCHESTRATION.md).

### Definitions

- **Embedder**: Object with `modelId`, `dimensions`, and `embed(texts)`.
- **Local ONNX**: In-process `Xenova/all-MiniLM-L6-v2` via
  `@huggingface/transformers` (384 dimensions).
- **Gemini embedder**: Hosted `gemini-embedding-001` (768 dimensions by default).
- **KB_EMBEDDER**: Env string that selects the backend.
- **Index build embed**: Cold `kb init` embed pass, and post-rescan
  `scanBaseRepos` embed pass.

### Scope

## In Scope

- Backend selection from `KB_EMBEDDER`
- Fail conditions for index builds when embed fails or misconfigures
- Gemini batch size, pace interval, retry vs hard-fail on quota
- Requirement that serve and build use matching backends

## Out of Scope

- LLM answer synthesis (Gemini chat) rate limits
- Object-store publish (`scripts/fly/refresh.sh` pointer flip)
- Ranking math inside hybrid RRF

### Functional Requirements

| ID | Requirement |
|------|-------------|
| FR-1 | [NEW] Unset, empty, `local`, or `onnx` for `KB_EMBEDDER` selects Local ONNX |
| FR-2 | [NEW] `KB_EMBEDDER=gemini` selects Gemini and requires a non-empty `GEMINI_API_KEY` |
| FR-3 | [NEW] Any other `KB_EMBEDDER` value throws; there is no special `none` backend |
| FR-4 | [NEW] Cold `kb init` embeds documents, symbols, and facts after write and throws if embed fails |
| FR-5 | [NEW] Post-rescan `scanBaseRepos` embed throws on failure and does not report success without vectors |
| FR-6 | [NEW] Gemini embed paces requests and retries only transient rate limits; billing and quota-exhausted errors fail without retry storms |
| FR-7 | [NEW] `embedAll*` without an attached embedder throws (it never silently no-ops) |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|---------|------------------|
| TC-6LYC | FR-1 | `KB_EMBEDDER` unset | `createEmbedder()` returns Local ONNX |
| TC-0Q63 | FR-1 | `KB_EMBEDDER=local` or `onnx` | Local ONNX |
| TC-9QQ4 | FR-2 | `KB_EMBEDDER=gemini` without `GEMINI_API_KEY` | Throws before any network call |
| TC-XR8H | FR-2 | `KB_EMBEDDER=gemini` with key | `modelId` starts with `gemini:` |
| TC-W56K | FR-3 | `KB_EMBEDDER=none` or `openai` | Throws unknown-backend error |
| TC-D9SP | FR-4 | Gemini returns 401 mid cold init | Init throws; no "Index build complete" success path |
| TC-80AI | FR-5 | Gemini quota message during post-rescan embed | `scanBaseRepos` throws; caller must not export as healthy |
| TC-L7HH | FR-6 | HTTP 429 resource_exhausted with Retry-After | Retries with sleep, then succeeds or fails after max retries |
| TC-BEY0 | FR-6 | Body text "exceeded your current quota" / billing details | Fails on first response (no multi-minute retry loop) |
| TC-DVAP | FR-7 | `embedAllDocuments` with no embedder attached | Throws |

### Known issues

- Query-time `cacheQueryEmbedding` (via `FactsDocumentReader`'s `tryCreateEmbedder`)
  remains best-effort (hash fallback) so a single failed query embed does not
  503 chat; index builds do not share that soft path — they call
  `createEmbedder`/`requireEmbedderForInit` directly and let misconfiguration throw.
- Interactive `kb init`/rescan (no `requireEmbeddings`) still logs a "skipped"
  progress line and continues on embed failure rather than aborting — only
  eval builds (`requireEmbeddings: true`) hard-fail, per FR-4's own escape hatch.
