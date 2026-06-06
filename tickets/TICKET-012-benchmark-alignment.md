# TICKET-012: Benchmark Tasks & Alignment Suite

**Status:** Open  
**Priority:** P3  
**Language:** TypeScript + YAML  
**Labels:** evaluation, benchmarks, tasks  
**Codebase anchor:** commit `241e1d2` (Add MOEL evaluation framework plan and ticket backlog)

## Context

The MOEL framework needs a curated task library that exercises scenarios where `kb` is most expected to help: fact retrieval, symbol navigation, cross-file reasoning, and documentation quality. Tasks are defined as YAML files extending the existing `eval/suites/*.yaml` format used by `eval-run.mjs`.

Results also need to be anchored to established benchmarks (SWE Atlas, SWE-ContextBench, CodeScaleBench) to be credible to external reviewers.

## Objective

Build the initial task library (minimum 10 tasks) in the existing YAML format with MOEL-specific extensions, and document how MOEL metrics map to external benchmark verification protocols.

---

## 1. Existing YAML Suite Format (exact schema, from `eval/suites/kb.yaml` and `eval/suites/raylib.yaml`)

Both suites share the same flat schema. All fields are required unless noted.

```yaml
# eval/suites/kb.yaml — canonical shape
schema_version: 1           # integer, always 1 currently
id: kb                      # string, no spaces — used as CLI --suite value and base-name prefix (eval-{id})
display_name: kb            # string, human-readable
repo_url: https://github.com/rosenjcb/kb.git   # string, full HTTPS URL
rubric_focus: the **kb** local-first knowledge CLI/repo  # string, injected into auto-score prompt
questions:                  # sequence of plain strings (no mapping, no ids, no answer inline)
  - "Question text here"
  - ...
answers:                    # parallel sequence of YAML block scalars, one per question
  - >
    Answer text, can be multi-line block scalar.
  - >
    ...
```

Key observations:
- `questions` and `answers` are **parallel arrays** — index 0 of `questions` pairs with index 0 of `answers`.
- Questions are bare strings; answers are YAML block scalars (`>` folded or `|` literal).
- There is no per-item `id`, `rubric`, `targetSymbols`, or `tokenBudget` at the suite level — those are MOEL extensions added in `moel-kb.yaml`.
- The existing suites carry **8 questions each** (not arbitrary length). MOEL may use more, but the auto-scorer loop in `eval-run.mjs` currently processes exactly 8; verify before extending.
- `rubric_focus` is injected verbatim into the auto-score prompt sent to Gemini/OpenAI.

---

## 2. Scoring Axes (from `EVALUATION.md` — jury rubric must align exactly)

The auto-scorer (`runAutoScoreFile()` in `eval-run.mjs`) evaluates four axes, each scored **0–4**:

| Axis | Score 4 (best) | Score 0 (worst) |
|------|----------------|-----------------|
| **Correctness** | Factually correct and grounded in the repo/KB | No useful answer |
| **Usefulness** | Directly helps a developer act or understand | Not helpful |
| **Specificity** | Uses concrete repo-specific details, commands, mechanisms | Purely generic or evasive |
| **Evidence Handling** | Constrained to evidence, appropriate uncertainty | No evidence discipline |

Pass threshold: `correctness >= 3` AND `usefulness >= 3`. Overall suite pass rate target: **70 %** (6/8 questions).

The MOEL jury rubric items in each task **must map to one of these four axes**. Each rubric bullet should state which axis it primarily tests. This ensures `L_MOEL` scores are comparable to the aggregate metrics in `artifact.json`.

---

## 3. Task YAML Format Extension (`eval/suites/moel-kb.yaml`)

The MOEL suite extends the base schema with per-task metadata. The `questions` / `answers` arrays are preserved for backward compatibility with `eval-run.mjs`; MOEL-specific fields live in a parallel `tasks` array keyed by position.

```yaml
# eval/suites/moel-kb.yaml
# Codebase anchor: commit 241e1d2
# Warning: moel-run.mjs compares HEAD against this commit and warns on divergence.

schema_version: 1
id: moel-kb
display_name: "MOEL — kb dogfood task library"
repo_url: https://github.com/rosenjcb/kb.git
rubric_focus: the **kb** local-first knowledge CLI/repo (MOEL task library, 10 tasks)

# ── Flat arrays for eval-run.mjs compatibility ──────────────────────────────
questions:
  - "How does kb's retrieval orchestrator decide when it has gathered sufficient evidence to answer?"
  - "What is the role of retrieval-lane-router.ts, and which lane types does it define?"
  - "What does TreeSitterIndexer extract from non-TypeScript files, and which languages does it support?"
  - "How does expandQueryWithGraph() improve retrieval recall, and which constants cap its output?"
  - "How do eval-run.mjs and the kb suite YAML coordinate LLM provider selection and auto-scoring?"
  - "What is the data flow from kb init to a fact appearing in read_facts results?"
  - "How does TokenCountingProvider integrate with the RunCollector stage telemetry system?"
  - "How does kb handle incremental rescans — what determines whether a file is re-indexed?"
  - "Write a one-paragraph description of the RunCollector class including its lifecycle and output format."
  - "Write a one-paragraph description of how fact_categories are assigned during kb init and kb scan."

answers:
  - >
    (reference answer — see eval/tasks/moel-kb-fact-retrieval-001/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-symbol-nav-002/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-symbol-nav-003/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-symbol-nav-004/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-cross-file-005/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-cross-file-006/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-cross-file-007/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-fact-retrieval-008/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-doc-quality-009/reference-answer.md)
  - >
    (reference answer — see eval/tasks/moel-kb-doc-quality-010/reference-answer.md)

# ── MOEL extensions — parallel to questions/answers arrays ──────────────────
tasks:
  - id: moel-kb-fact-retrieval-001
    category: fact-retrieval
    question: "How does kb's retrieval orchestrator decide when it has gathered sufficient evidence to answer?"
    targetSymbols:
      - "FactsQueryResearchOrchestrator"   # src/tools/facts-query-research-orchestrator.ts
      - "assessSufficiency"                # private method, line ~352
      - "answerable_plateau"               # LoopStopReason literal
      - "plateauCount"                     # loop variable tracking hasMeaningfulProgress stalls
    rubric:
      - axis: correctness
        check: "Identifies assessSufficiency() as the stopping mechanism — requires score >= 0.40 on at least 10 facts."
      - axis: correctness
        check: "Names the LoopStopReason values correctly: answerable_plateau, frontier_exhausted, weak_evidence_after_exhaustion, budget_exhausted."
      - axis: specificity
        check: "Mentions the numeric threshold (score >= 0.40, minimum 10 relevant facts) rather than describing stopping in vague terms."
      - axis: evidence_handling
        check: "Does not hallucinate function names such as detectPlateau() or checkSufficiency() — neither exists in the codebase."
    tokenBudget: 150000
    stepCeiling: 15
    oracleFactIds: []   # populated by moel-run.mjs at runtime via SQLite BFS from targetSymbols

  - id: moel-kb-symbol-nav-002
    category: symbol-navigation
    question: "What is the role of retrieval-lane-router.ts, and which lane types does it define?"
    targetSymbols:
      - "RetrievalLane"               # src/tools/retrieval-lane-router.ts — union type
      - "routeQueryToLanes"           # exported function
      - "classifyDocumentLane"        # exported function
      - "laneFitnessBoost"            # exported function — returns 0.15 / 0.10 / 0.05 / 0.02
      - "LaneRoutingDecision"         # interface with lanes, fallbackLanes, lastResortLanes, reason
    rubric:
      - axis: correctness
        check: "Lists all six RetrievalLane values: error-runbook, fact, policy, architecture, session-log, workflow."
      - axis: specificity
        check: "Describes laneFitnessBoost() and its scoring tier (0.15 for index 0, 0.10 for index 1, etc.)."
      - axis: correctness
        check: "Distinguishes routeQueryToLanes() (query → lanes) from classifyDocumentLane() (document → single lane)."
      - axis: evidence_handling
        check: "Does not conflate lane routing with FTS or semantic scoring — lane fitness is a post-retrieval reranking boost."
    tokenBudget: 120000
    stepCeiling: 12
    oracleFactIds: []

  - id: moel-kb-symbol-nav-003
    category: symbol-navigation
    question: "What does TreeSitterIndexer extract from non-TypeScript files, and which languages does it support?"
    targetSymbols:
      - "TreeSitterIndexer"           # src/tools/tree-sitter-indexer.ts — class
      - "LANG_CONFIGS"                # const Record<string, LangConfig> — the registry
      - "LangConfig"                  # interface: wasmPath, importQueries, exportQueries, goExportConvention
      - "goExportConvention"          # boolean flag — Go uppercase-initial convention
      - "tombstoneStaleAstFacts"      # called on changed/deleted files
    rubric:
      - axis: correctness
        check: "Enumerates the supported languages from LANG_CONFIGS: Go, TypeScript, TSX, JavaScript, JSX, Python, Rust, Ruby, Java, C, C++, C# (.cs), CSS, Bash, PHP, Scala, HTML."
      - axis: specificity
        check: "Notes the goExportConvention flag and explains its effect (only uppercase-initial identifiers treated as exported in Go)."
      - axis: correctness
        check: "States that both import and export queries are tree-sitter S-expression captures, writing IMPORTS_FILE and EXPORTS_SYMBOL facts."
      - axis: evidence_handling
        check: "Does not claim TreeSitterIndexer handles TypeScript with ts-morph — that is TsMorphIndexer (code-graph-indexer.ts)."
    tokenBudget: 120000
    stepCeiling: 12
    oracleFactIds: []

  - id: moel-kb-symbol-nav-004
    category: symbol-navigation
    question: "How does expandQueryWithGraph() improve retrieval recall, and which constants cap its output?"
    targetSymbols:
      - "expandQueryWithGraph"        # src/tools/graph-query-expansion.ts — exported function
      - "toGraphQuerySlugs"           # converts query → slug tokens + bigrams
      - "MAX_SEMANTIC_EXPANSION"      # const 18 — LIKE-scan cap
      - "MAX_CODE_EXPANSION"          # const 8  — code-graph symbol cap
    rubric:
      - axis: correctness
        check: "Identifies two expansion passes: (1) FTS on facts_fts (source_kind=import_code) + 1-hop fact_edges; (2) LIKE-scan of facts subject/object."
      - axis: specificity
        check: "States the exact cap values: MAX_CODE_EXPANSION=8 symbols from code graph, MAX_SEMANTIC_EXPANSION=18 terms from LIKE-scan."
      - axis: specificity
        check: "Mentions that toGraphQuerySlugs() generates both unigrams and bigrams (e.g. 'api-key', 'knowledge-graph') to match compound entity IDs."
      - axis: correctness
        check: "Correctly identifies callers: src/cli/index.ts, src/cli/chat-cli.ts, and src/tools/graph-rag-reranker.ts."
    tokenBudget: 120000
    stepCeiling: 12
    oracleFactIds: []

  - id: moel-kb-cross-file-005
    category: cross-file-reasoning
    question: "How do eval-run.mjs and the kb suite YAML coordinate LLM provider selection and auto-scoring?"
    targetSymbols:
      - "runAutoScoreFile"            # function in scripts/eval-run.mjs
      - "rubric_focus"                # field in suite YAML — injected into auto-score prompt
      - "GEMINI_API_KEY"              # env var checked at auto-score time
      - "OPENAI_API_KEY"              # fallback env var
    rubric:
      - axis: correctness
        check: "Explains that rubric_focus from the suite YAML is injected into the LLM auto-score prompt."
      - axis: correctness
        check: "Names both provider env vars (GEMINI_API_KEY → gemini-2.5-flash, OPENAI_API_KEY as fallback) and that --manual-score opts out."
      - axis: specificity
        check: "States that all 8 Q&A pairs are sent in a single batch to the scoring LLM, results saved to auto-scores.json and artifact.json."
      - axis: evidence_handling
        check: "Does not conflate the eval LLM (scorer) with the query LLM (answerer) — they are configured independently."
    tokenBudget: 150000
    stepCeiling: 15
    oracleFactIds: []

  - id: moel-kb-cross-file-006
    category: cross-file-reasoning
    question: "What is the data flow from kb init to a fact appearing in read_facts results?"
    targetSymbols:
      - "TsMorphIndexer"              # src/tools/code-graph-indexer.ts — TS/JS indexer
      - "TreeSitterIndexer"           # src/tools/tree-sitter-indexer.ts — multi-lang indexer
      - "facts"                       # SQLite table — primary facts store
      - "facts_fts"                   # SQLite FTS5 virtual table
      - "fact_embeddings"             # SQLite table — semantic vectors
      - "fact_categories"             # SQLite table — TF-IDF category assignments
      - "code_file_state"             # SQLite table — content-hash change tracking
    rubric:
      - axis: correctness
        check: "Enumerates the 5 checkpointed init cycles: read-inputs, code-index, document-facts, import-docs, write."
      - axis: correctness
        check: "Names all SQLite tables written: facts, fact_edges, facts_fts (FTS5), fact_embeddings, documents, fact_categories, code_file_state."
      - axis: specificity
        check: "Distinguishes source_kind='import_code' (AST indexers) from source_kind='doc' (markdown sentence segmentation)."
      - axis: evidence_handling
        check: "Does not describe read_facts as a separate service — it queries the same .kb-index.sqlite database written by init."
    tokenBudget: 150000
    stepCeiling: 15
    oracleFactIds: []

  - id: moel-kb-cross-file-007
    category: cross-file-reasoning
    question: "How does TokenCountingProvider integrate with the RunCollector stage telemetry system?"
    targetSymbols:
      - "TokenCountingProvider"       # src/core/telemetry.ts — wraps LLMProvider
      - "RunCollector"                # src/core/telemetry.ts — accumulates StageMetrics
      - "StageMetrics"                # interface: stage, startedAt, durationMs, inputTokens, outputTokens, estimatedCostUsd, provider, model
      - "RunReport"                   # interface: runId, totalInputTokens, totalOutputTokens, stages[]
      - "getAndReset"                 # method on TokenCountingProvider — reads + resets counters
      - "startStage"                  # method on RunCollector — returns closer function
      - "ReportWriter"                # src/core/telemetry.ts — appends NDJSON to ~/.kb/logs/YYYY-MM-DD.jsonl
    rubric:
      - axis: correctness
        check: "Explains that TokenCountingProvider wraps any LLMProvider and accumulates _inputTokens/_outputTokens across all call() invocations."
      - axis: correctness
        check: "Describes getAndReset() — returns {inputTokens, outputTokens} and resets counters — used between init cycles."
      - axis: specificity
        check: "Notes that RunCollector.startStage() returns a closer function (not a promise) and that addStage() is called with the completed StageMetrics."
      - axis: specificity
        check: "States that ReportWriter appends NDJSON (one RunReport per line) to ~/.kb/logs/YYYY-MM-DD.jsonl and never throws."
    tokenBudget: 120000
    stepCeiling: 12
    oracleFactIds: []

  - id: moel-kb-fact-retrieval-008
    category: fact-retrieval
    question: "How does kb handle incremental rescans — what determines whether a file is re-indexed?"
    targetSymbols:
      - "code_file_state"             # SQLite table — stores content hashes
      - "getCodeFileState"            # src/tools/code-fact-writer.ts — reads current hash
      - "upsertCodeFileState"         # src/tools/code-fact-writer.ts — writes new hash
      - "tombstoneStaleCodeFacts"     # src/tools/code-fact-writer.ts — marks stale facts
      - "RescanApplyOrchestrator"     # src/tools/rescan-apply-orchestrator.ts — orchestrates scan
    rubric:
      - axis: correctness
        check: "States that kb scan is equivalent to kb init --rescan --apply, and that it skips the category interview."
      - axis: specificity
        check: "Identifies content-hash comparison via code_file_state as the change-detection mechanism (not mtime or file size)."
      - axis: correctness
        check: "Notes that stale facts from deleted or changed files are tombstoned via tombstoneStaleCodeFacts / tombstoneStaleAstFacts."
      - axis: correctness
        check: "Explains that uncategorized facts are re-assigned to existing categories via TF-IDF cosine similarity at threshold 0.3 (not re-interviewed)."
    tokenBudget: 120000
    stepCeiling: 12
    oracleFactIds: []

  - id: moel-kb-doc-quality-009
    category: doc-quality
    question: "Write a one-paragraph description of the RunCollector class including its lifecycle and output format."
    targetSymbols:
      - "RunCollector"                # src/core/telemetry.ts
      - "StageMetrics"
      - "RunReport"
      - "ReportWriter"
    rubric:
      - axis: correctness
        check: "States that RunCollector is instantiated with a command string and optional {sessionId, base}; generates a runId on construction."
      - axis: correctness
        check: "Describes lifecycle: constructor → startStage() (returns closer) → addStage() → finish() → RunReport."
      - axis: specificity
        check: "Names the RunReport fields: runId, command, startedAt, finishedAt, totalDurationMs, totalInputTokens, totalOutputTokens, totalEstimatedCostUsd, stages[], status."
      - axis: usefulness
        check: "Paragraph is self-contained and accurate enough to use as inline JSDoc without further editing."
    tokenBudget: 100000
    stepCeiling: 10
    oracleFactIds: []

  - id: moel-kb-doc-quality-010
    category: doc-quality
    question: "Write a one-paragraph description of how fact_categories are assigned during kb init and kb scan."
    targetSymbols:
      - "fact_categories"             # SQLite table
      - "inferCategoriesForQuery"     # SqliteKbIndexer method — TF-IDF cosine similarity
    rubric:
      - axis: correctness
        check: "States that during init, categories are assigned via an interactive TF-IDF cosine similarity interview (skipped with --non-interactive)."
      - axis: correctness
        check: "States that during scan, uncategorized facts are auto-assigned to existing categories at cosine similarity threshold 0.3 — no interview."
      - axis: specificity
        check: "Paragraph does not confuse fact_categories (assignment table) with fact_embeddings (semantic vectors used for hybrid scoring)."
      - axis: usefulness
        check: "Paragraph is self-contained and accurate enough to use as inline documentation without further editing."
    tokenBudget: 100000
    stepCeiling: 10
    oracleFactIds: []
```

---

## 4. Concrete Reference Answers (expert-written, for AST and jury comparison)

### Task `moel-kb-fact-retrieval-001` — Evidence Sufficiency

**File:** `eval/tasks/moel-kb-fact-retrieval-001/reference-answer.md`

```markdown
`FactsQueryResearchOrchestrator.run()` (src/tools/facts-query-research-orchestrator.ts) stops
collecting evidence through the private `assessSufficiency()` method, which is called after each
iteration. The check is entirely deterministic — no LLM prompt is involved. It filters
`scoredFacts` to entries where `score >= 0.40` and returns `decision: 'answerable'` when at least
10 such facts have been accumulated; otherwise it returns `decision: 'not_answerable_yet'` with
reason `'insufficient-facts'`.

When `assessSufficiency()` returns `'answerable'`, the loop sets `stopReason = 'answerable_plateau'`
and breaks. Three other stop conditions exist: `frontier_exhausted` (all exploration ponds are
marked exhausted and no new facts appear), `weak_evidence_after_exhaustion` (frontier is empty but
fewer than 10 high-scoring facts were found), and `budget_exhausted` (the fact limit or absolute
iteration cap of 512 was reached). The stop reason is recorded in the `retrieval.detail` field of
the `QueryResponse` as `stop:<reason>` alongside pass count, graph hops, and pond count.

Separately, the loop tracks a `plateauCount` via `hasMeaningfulProgress()`. If `plateauCount >= 2`
and the graph/concept frontier cannot be widened further, the loop also stops — this is the
"plateau" branch that sets `stopReason = 'answerable_plateau'` or `'weak_evidence_after_exhaustion'`
depending on the current sufficiency decision. This plateau guard prevents wasted iterations when
each pass adds fewer than 2 new unique facts, less than 0.08 additional concept coverage, and less
than 0.04 improvement in the top-score average.
```

### Task `moel-kb-cross-file-007` — TokenCountingProvider + RunCollector Integration

**File:** `eval/tasks/moel-kb-cross-file-007/reference-answer.md`

```markdown
`TokenCountingProvider` (src/core/telemetry.ts) wraps any `LLMProvider` implementation and
intercepts every `call()` response to accumulate `_inputTokens` and `_outputTokens`. It does not
alter the response — it passes through to `this.inner.call()` and adds the usage counts after the
fact. The `getAndReset()` method returns the running totals as `{inputTokens, outputTokens}` and
resets both counters to zero; this is called between init cycles so each cycle is measured
independently. The `peek()` method reads totals without resetting.

`RunCollector` (src/core/telemetry.ts) is the per-command accumulator. It is constructed with a
`command` string and optional `{sessionId, base}`; the constructor generates a `runId` of the form
`run-<timestamp>-<4chars>` and records `startedAt`. During a command run, callers use
`startStage(stage, provider, model)`, which captures `Date.now()` and returns a closer function.
When a stage finishes, the caller invokes the closer with `{inputTokens, outputTokens}`; the closer
computes `durationMs`, calls `estimateCost()` (via the `pricetoken` library), and calls `addStage()`
to push a `StageMetrics` record. Calling `finish(status)` aggregates all stages into a `RunReport`
with summed `totalInputTokens`, `totalOutputTokens`, and `totalEstimatedCostUsd`.

`ReportWriter` appends the completed `RunReport` as a single JSON line (NDJSON) to
`~/.kb/logs/YYYY-MM-DD.jsonl`. It creates the directory on first write and swallows all errors with
a stderr warning — it never throws, so a log failure cannot abort a kb command.
```

---

## 5. Git Commit Hash Tracking

The codebase anchor is stored as a **YAML comment at the top of `moel-kb.yaml`** (not a field), because `eval-run.mjs` does not parse extra top-level keys and a comment is safe for forward compatibility. Additionally, `moel-run.mjs` reads the comment at startup using a regex parse and runs `git rev-parse HEAD` to compare; it prints a warning if the repo HEAD has diverged from the anchored commit.

```yaml
# Codebase anchor: commit 241e1d2
# Warning: moel-run.mjs compares HEAD against this commit and warns on divergence.
```

To update the anchor after codebase changes:
1. Re-verify all `targetSymbols` still exist at the new HEAD.
2. Update the comment hash.
3. Recompute `optimal-actions-K.json` and `optimal-actions-N.json` for affected tasks.

---

## Acceptance Criteria

### Task Library (minimum 10 tasks across 4 categories)

**Fact Retrieval (2 tasks)**
- [ ] `moel-kb-fact-retrieval-001` — Evidence sufficiency in `FactsQueryResearchOrchestrator` (`assessSufficiency`, `answerable_plateau`)
- [ ] `moel-kb-fact-retrieval-008` — Incremental rescan change detection (`code_file_state`, `tombstoneStaleCodeFacts`)

**Symbol Navigation (3 tasks)**
- [ ] `moel-kb-symbol-nav-002` — `retrieval-lane-router.ts`: `RetrievalLane` union, `routeQueryToLanes`, `laneFitnessBoost`
- [ ] `moel-kb-symbol-nav-003` — `TreeSitterIndexer`: `LANG_CONFIGS`, supported languages, `goExportConvention`
- [ ] `moel-kb-symbol-nav-004` — `expandQueryWithGraph`: two passes, `MAX_CODE_EXPANSION=8`, `MAX_SEMANTIC_EXPANSION=18`

**Cross-File Reasoning (3 tasks)**
- [ ] `moel-kb-cross-file-005` — `eval-run.mjs` + suite YAML: `rubric_focus`, auto-scorer provider selection
- [ ] `moel-kb-cross-file-006` — `kb init` data flow: 5 cycles, all SQLite tables, `source_kind` values
- [ ] `moel-kb-cross-file-007` — `TokenCountingProvider` + `RunCollector` + `ReportWriter` integration

**Documentation Quality (2 tasks)**
- [ ] `moel-kb-doc-quality-009` — `RunCollector` lifecycle and `RunReport` output
- [ ] `moel-kb-doc-quality-010` — `fact_categories` assignment during init vs. scan

### Task Artifacts (per task directory)

- [ ] `eval/suites/moel-kb.yaml` — complete file with all 10 tasks as specified above
- [ ] `eval/tasks/<taskId>/reference-answer.md` — expert-written reference (2 already written above; 8 remaining)
- [ ] `eval/tasks/<taskId>/optimal-actions-K.json` — pre-computed BFS fact IDs from `targetSymbols` via SQLite query
- [ ] `eval/tasks/<taskId>/optimal-actions-N.json` — pre-computed file paths from `git grep -l <symbol>` for each `targetSymbol`

### Benchmark Alignment Documentation

- [ ] `eval/benchmarks/alignment.md` covering:
  - SWE Atlas: how manifest + mutation checks satisfy programmatic check requirements; how MOEL differs (AST distance vs. static reference text matching)
  - SWE-ContextBench: how `L_resource` and trajectory tracking maps to their time-efficiency and cache-token-cost metrics
  - CodeScaleBench: how the three-condition comparison (K/N/O) maps to their task/outcome/tool validity tiers; explicit call-outs of differences

### Summary Reporter

- [ ] `eval/reports/summary.ts` produces a Markdown and JSON comparison table:
  ```
  Task ID                      | N L_MOEL | K L_MOEL | O L_MOEL | N-K Delta | Hypothesis
  -----------------------------|----------|----------|----------|-----------|----------
  moel-kb-fact-retrieval-001   |  0.72    |  0.31    |  0.18    |  +0.41    | ✓
  ```
  Scoring columns must use the four axes from `EVALUATION.md`: `correctness`, `usefulness`, `specificity`, `evidence_handling` (each 0–4). `L_MOEL` is the mean across all four axes for that condition.
- [ ] Aggregate row: mean `L_MOEL` per condition, overall `N - K` delta.

---

## Implementation Notes

### Field Definitions for MOEL YAML Extensions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Kebab-case task identifier. Pattern: `moel-kb-{category}-{NNN}`. |
| `category` | enum | yes | One of: `fact-retrieval`, `symbol-navigation`, `cross-file-reasoning`, `doc-quality`. |
| `question` | string | yes | Must match the corresponding entry in the top-level `questions` array exactly (by index). |
| `targetSymbols` | string[] | yes | Real exported names or interface/type names from the codebase. Comments must include the file path. Verified to exist at the anchor commit. |
| `rubric` | object[] | yes | Each item has `axis` (one of `correctness`, `usefulness`, `specificity`, `evidence_handling`) and `check` (string — the specific assertion the jury evaluates). |
| `tokenBudget` | integer | yes | Maximum input tokens for Condition K and N runs. |
| `stepCeiling` | integer | yes | Maximum tool-call steps before the agent is forced to answer. |
| `oracleFactIds` | string[] | yes | Empty at commit time; populated by `moel-run.mjs` at runtime via SQLite BFS from `targetSymbols`. Do not hand-populate. |

### Task Selection Rationale

All tasks are drawn from the kb repo itself (dogfooding). This prevents benchmark contamination — no external repo that a model might have memorized. Tasks are tagged with the git commit hash they were designed against via the YAML comment; the harness warns if the repo has diverged from anchor commit `241e1d2`.

`targetSymbols` in each task are verified to be real, exported symbols (or named interfaces/types) present in the codebase at the anchor commit. All symbol names in the YAML above have been cross-checked against the source files listed in their inline comments.

### Pre-Computing Optimal Actions

**Condition K (`optimal-actions-K.json`):** Run a BFS query against the kb SQLite database (after `kb init --base dogfood --non-interactive` on the repo) starting from each `targetSymbol`. Record the fact IDs returned within 2 graph hops. Format:
```json
{ "taskId": "moel-kb-fact-retrieval-001", "factIds": ["fact:...", "fact:..."], "queryMethod": "bfs-2-hop", "anchorCommit": "241e1d2" }
```

**Condition N (`optimal-actions-N.json`):** For each `targetSymbol`, run `git grep -l <symbol>` at the anchor commit. Record unique file paths. Format:
```json
{ "taskId": "moel-kb-fact-retrieval-001", "filePaths": ["src/tools/facts-query-research-orchestrator.ts", ...], "queryMethod": "git-grep", "anchorCommit": "241e1d2" }
```

Both files are pre-computed once and committed. The harness reads them rather than recomputing at evaluation time. If the anchor commit changes, both must be regenerated for all affected tasks.

---

## Files to Create

- `eval/suites/moel-kb.yaml` — full YAML as specified in §3 above
- `eval/tasks/moel-kb-fact-retrieval-001/reference-answer.md` (written above in §4)
- `eval/tasks/moel-kb-fact-retrieval-001/optimal-actions-K.json`
- `eval/tasks/moel-kb-fact-retrieval-001/optimal-actions-N.json`
- `eval/tasks/moel-kb-cross-file-007/reference-answer.md` (written above in §4)
- `eval/tasks/moel-kb-cross-file-007/optimal-actions-K.json`
- `eval/tasks/moel-kb-cross-file-007/optimal-actions-N.json`
- *(8 remaining task directories following the same pattern)*
- `eval/benchmarks/alignment.md`
- `eval/reports/summary.ts`

## Dependencies

TICKET-010, TICKET-011

## Feeds Into

Final experiment runs and external publication.
