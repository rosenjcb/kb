# TICKET-010: Extend eval-run.mjs with MOEL Conditions

**Status:** Open  
**Priority:** P1  
**Language:** TypeScript  
**Labels:** evaluation, harness, infrastructure

## Context

`scripts/eval-run.mjs` is a 1300+ line evaluation harness that already handles session lifecycle, YAML task loading, LLM auto-scoring, artifact output, and trends comparison. It is production-grade and should not be replaced.

This ticket adds `scripts/moel-run.mjs` — a parallel script that runs the same YAML task suites under all three MOEL conditions (N, K, O), feeds each run through the loss pipeline, and emits structured comparison reports. It shares the session lifecycle logic from `eval-run.mjs` but adds condition management and MOEL metric collection.

The three conditions control which tools the agent has access to:
- **Condition N:** `read_file`, `list_directory`, `search_file_contents` only. No kb tools.
- **Condition K:** The full kb tool registry: `read_facts`, `search_code_symbols`, `get_code_neighbors`, `get_code_graph_summary`.
- **Condition O:** No tools. Relevant facts injected from the kb SQLite database directly into the system prompt.

## Objective

Implement `scripts/moel-run.mjs` that orchestrates three-condition evaluation runs and produces per-task `MoelResult` comparisons.

## Acceptance Criteria

- [ ] Loads task suites from `eval/suites/*.yaml` (same format as `eval-run.mjs`; extended fields described in TICKET-012).
- [ ] For each task, runs the agent under Condition N, K, and O sequentially.
- [ ] Each condition run uses a distinct Claude Code session base: `moel-{suiteId}-{condition}` (e.g., `moel-kb-N`).
- [ ] `TrajectoryCollector` (TICKET-001) is attached to each run and writes trajectory JSON alongside the existing `artifact.json`.
- [ ] After each run, computes: `L_AST` (TICKET-002), `L_jury` (TICKET-003), `L_trajectory` (TICKET-004), `L_resource` (TICKET-005), `L_MOEL` (TICKET-006).
- [ ] Manifest validation (TICKET-009) runs after each condition.
- [ ] Mutation check (TICKET-009) runs once (condition-agnostic, verifies the repo's test suite is wired correctly).
- [ ] Output written to `~/.kb/evaluations/moel-{suiteId}-{runTimestamp}/`:
  - `trajectory_N.json`, `trajectory_K.json`, `trajectory_O.json`
  - `moel_results.json` — full `MoelResult` per condition
  - `comparison_report.json` — `ComparisonReport` from TICKET-006
- [ ] Hard limits: `stepCeiling = 20`, `tokenBudget = 250_000`. Runs exceeding these are terminated (TICKET-011) and losses set to `1.0`.
- [ ] `--suite <suiteId>` and `--condition <N|K|O|all>` CLI flags (default: all three).
- [ ] `--dry-run` flag prints the plan without executing agent sessions.

## Implementation Notes

### Shared Module: eval-shared.mjs

Extract the following functions from `scripts/eval-run.mjs` into `scripts/eval-shared.mjs`. These are the exact exported and exportable names already present in the file:

**Currently exported** (already marked `export` in eval-run.mjs — move the declaration):
- `sanitizeSlugPart(s)` — normalizes a string into a safe slug segment
- `repoLeafNameFromUrl(url)` — extracts the repo leaf name from a git URL
- `stripCliBanner(text)` — strips the CLI banner prefix before the first `{` in output
- `derivedBase(suiteId)` — computes `eval-{suiteId}` session base name
- `parseQueryText(text)` — parses prose `kb query` output into `{ answer, result_count, provenance, retrieval }`
- `parseGraphCounts(graphText)` — parses `Entities: N / Relationships: N` from `kb graph` output
- `buildCoverageAudit(question, answer, retrievalDetail)` — derives facet coverage metrics
- `scoreMetric(artifact, key)` — reads a score metric from an artifact object
- `structuralMetric(artifact, key)` — reads a structural metric from an artifact object
- `matchesSuite(row, suite)` — filters trend rows by suite id
- `sparkline(values, maxWidth?)` — renders a unicode sparkline from a numeric series

**Also extract** (currently unexported in eval-run.mjs — add `export` when moving):
- `evaluationsRoot()` — returns `path.join(os.homedir(), '.kb', 'evaluations')`
- `normalizeSuiteDoc(raw, sourceFile)` — validates and normalizes a raw YAML suite object
- `loadVendorSuite(suiteId)` — loads and normalizes a suite from `eval/suites/<id>.yaml`
- `listSuiteIds()` — scans `eval/suites/` and returns available suite ids

Do not copy-paste. `eval-run.mjs` imports from `eval-shared.mjs`; `moel-run.mjs` also imports from `eval-shared.mjs`.

### Claude Code Session Invocation

`eval-run.mjs` does **not** invoke `claude --session` or `claude -p`. It runs kb's own CLI (`node dist/bin/kb.js`) directly:

```js
// From eval-run.mjs — the kb() helper:
function kb(cwd, args, opts = {}) {
  const bin = path.join(KB_REPO, 'dist/bin/kb.js')
  return execSync(`node "${bin}" ${args}`, { encoding: 'utf8', env: kbEnv(), cwd, ... })
}
```

Session lifecycle uses `kb init --base <name> --non-interactive --debug` (init) and `kb query "<question>" --base <name>` (query). The base name follows the formula `eval-{suiteId}` (e.g., `eval-kb`, `eval-raylib`). For MOEL, the base names must be `moel-{suiteId}-N`, `moel-{suiteId}-K`, `moel-{suiteId}-O`.

Session reuse check: call `kb docs list --base <name>` and parse the `Count: N` line. If N > 0, skip init; otherwise run init first.

### Condition K Tool Schema Surfacing

`skill-installer.ts` does **not** inject JSON tool schemas into a session prompt. Instead it writes markdown SKILL.md files to disk in the agent's profile directory:

- Claude Code: `~/.claude/skills/<skillName>/SKILL.md`
- Cursor: `~/.cursor/rules/<skillName>.mdc`
- Codex: `~/.codex/skills/<skillName>.md`
- Copilot: `~/.github/copilot-instructions/<skillName>.md`

Each file gets a content-hash header (`<!-- kb-skill-hash: <sha256[:12]> -->`) for idempotent updates. For Cursor the `alwaysApply: true` front matter key is injected.

For Condition K in `moel-run.mjs`, the kb tool schemas (`read_facts`, `search_code_symbols`, `get_code_neighbors`, `get_code_graph_summary`) are defined in `src/tools/kb-tools-registry.ts` via `createKBToolsRegistry()`. The exact `ToolDefinition` schema objects for those four tools live in that function. Do not duplicate them in `moel-run.mjs`. Instead:

1. Import `createKBToolsRegistry` and call `.list()` on the returned registry to get the `ToolDefinition[]`.
2. Serialize these schemas into the Condition K system prompt as a JSON block:

```
<kb-tools>
The following tool schemas are available in this session:
[paste JSON array of ToolDefinition objects]
</kb-tools>
```

### Condition O Oracle Injection

For each task, query the kb SQLite database to retrieve the minimal set of facts covering the task's `targetSymbols` field (defined in the task YAML). Format the facts as a structured context block in the system prompt:

```
<oracle-context>
The following facts are provided for this task:
[fact: {title}] {content}
...
</oracle-context>
```

The agent in Condition O has no tools — it must answer solely from this injected context.

### artifact.json Schema

The `artifact.json` produced by `eval-run.mjs` has the following top-level fields (exact keys):

```jsonc
{
  "schema_version": 1,                // integer
  "evaluation_plan": "EVALUATION.md", // string
  "run_label": "<label>",             // string — --label flag or run folder name
  "status": "complete" | "partial",   // string
  "created_at": "<ISO 8601>",         // string
  "repository": {
    "name": "<repoLeaf>",             // string
    "branch": "<git branch>",         // string
    "commit": "<full SHA>",           // string
    "clone_path": "<abs path>"        // string
  },
  "hypothesis": "<string>",           // string
  "run": {
    "base": "<session base>",         // string
    "eval_mode": "all" | "query",     // string
    "suite": "<suiteId>",             // string
    "run_name": "<run folder>",       // string
    "evaluations_root": "~/.kb/evaluations", // string
    "question_suite_file": "<relative path>", // string
    "clone_url": "<git url> | null",  // string | null
    "target_cwd": "<abs path>",       // string
    "mode": "query_only_harvest" | "non_interactive_cli_init", // string
    "commands": ["<string>", ...],    // string[]
    "workdir": "<abs path>",          // string
    "run_dir": "<abs path>",          // string
    "publish_dir": null,              // null
    "init_result": {
      "status": "accepted" | "not_run" | "unknown", // string
      "written_docs": 0,              // number
      "written_doc_ids": [],          // string[]
      "init_run_id": "<id> | null",   // string | null
      "init_run_id_note": "<string> | null", // string | null
      "docs_list": { "count": 0 },   // object
      "graph_summary": {
        "entities": 0,               // number
        "relationships": 0           // number
      }
    }
  },
  "question_set": ["<string>", ...],  // string[8]
  "query_scoring": null | {           // object | null
    "mode": "llm_judge_single_shot",
    "provider": "gemini" | "openai",
    "model": "<model id>",
    "scores_file": "<abs path>"
  },
  "query_evaluation": [               // array[8]
    {
      "question_id": 1,               // number (1-indexed)
      "question": "<string>",         // string
      "result_count": 0,              // number
      "retrieval": {
        "method": "<string> | null",
        "detail": "<string> | null",
        "confidence": null
      },
      "answer_excerpt": "<string> | null", // first 280 chars of answer
      "provenance": ["<string>", ...], // string[]
      "coverage_audit": {
        "facets": ["<string>", ...],
        "missing_facets": ["<string>", ...],
        "covered_count": 0,
        "coverage_ratio": 0.0
      },
      "scores": {
        "correctness": 0,             // integer 0-4
        "usefulness": 0,              // integer 0-4
        "specificity": 0,             // integer 0-4
        "evidence_handling": 0        // integer 0-4
      },
      "notes": "<string>"             // string
    }
  ],
  "coverage_audit": {
    "mean_coverage_ratio": 0.0,       // number
    "questions_with_missing_facets": [{ "question_id": 0, "missing_facets": [] }]
  },
  "chat_evaluation": {
    "status": "not_captured",
    "notes": "<string>"
  },
  "aggregate_scores": {
    "query": {
      "mean_correctness": 0.0,
      "mean_usefulness": 0.0,
      "mean_specificity": 0.0,
      "mean_evidence_handling": 0.0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0.0
    },
    "chat": { ... },                  // same shape, zeroed for batch runs
    "combined": { ... }               // same shape as query
  },
  "qualitative_findings": ["<string>", ...], // string[]
  "next_improvement_areas": ["<string>", ...]  // string[]
}
```

`moel_results.json` and `comparison_report.json` are new output files defined by TICKET-006; they are not part of the existing `artifact.json` schema. The output directory for a MOEL run is `~/.kb/evaluations/moel-{suiteId}-{runTimestamp}/`.

### Condition N Filesystem Tools

There are no existing `eval/tools/` files in the repo — the directory does not exist yet. The tool wrapper pattern to follow is in `src/tools/kb-tools-registry.ts`: use `createToolRegistry()` from `src/core/tool-registry`, then call `registry.register(name, toolDef, handler)` for each tool. Each tool definition is a `ToolDefinition` with `name`, `description`, and `schema` (JSON Schema object).

For `eval/tools/filesystem-tools.ts`, implement three tools following that same pattern:

- `read_file(path: string): string` — reads a file at an absolute path, returns UTF-8 content
- `list_directory(path: string): string[]` — returns names of entries in the directory
- `search_file_contents(path: string, pattern: string): string[]` — greps lines matching the pattern (use Node's `fs` + manual line filtering, not `execSync grep`, to stay cross-platform)

Export a factory function `createFilesystemToolsRegistry(): ToolExecutor` (mirroring `createKBToolsRegistry`). Register these via `ToolRegistryImpl` + `ToolExecutorImpl` from `src/tools/tool-executor.ts`.

### Sharing Logic with eval-run.mjs

Extract the session lifecycle functions (see "Shared Module: eval-shared.mjs" section above) into `scripts/eval-shared.mjs` that both scripts import. Do not copy-paste.

## Files to Create

- `scripts/moel-run.mjs`
- `scripts/eval-shared.mjs` (extracted from `eval-run.mjs`)
- `eval/tools/filesystem-tools.ts`

## Files to Modify

- `scripts/eval-run.mjs` — refactor shared logic into `eval-shared.mjs`; replace duplicated definitions with imports
- `package.json` — add `"moel": "node scripts/moel-run.mjs"` script

## Dependencies

TICKET-001, TICKET-006, TICKET-008, TICKET-009

## Feeds Into

TICKET-011, TICKET-012
