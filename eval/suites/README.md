---
type: "Reference"
title: "Eval Question Suites"
description: "YAML schema and conventions for the question packs loaded by --suite."
resource: ./eval/suites
tags: [eval, suites, yaml]
timestamp: 2026-08-15T00:00:00Z
---

# Eval question suites (YAML)

`--suite <name>` loads `eval/suites/<name>.yaml` (or `.yml`). `--suite` can also be a path to a YAML file.

Each file needs: `id`, `rubric_focus`, a non-empty `questions` array, and optionally:
- `repo_url` (default clone URL used when `--repo` is omitted)
- `answers` (same length as `questions`; golden answers for the LLM judge)
- `shapes` (positional; `conceptual` \| `investigative`; absent ⇒ all conceptual)
- `gold_files` (positional; graded-retrieval qrels — see below)
- `display_name`

Disposable KB base names are **not** configured here — `eval-run.mjs` defaults `--base` to
`eval-{suiteId}` (reuse across runs). Override with `--base` if needed.

## Graded retrieval (`gold_files`)

The prose rubric grades the synthesized answer. The **citation list** is graded separately
against optional per-question gold file sets (issue #237):

```yaml
gold_files:
  - null   # skip retrieval axis for this question
  - - path: packages/kb-core/src/tools/hybrid-retriever.ts
      role: must_open
      symbol: fuseLane   # optional; documentation only today
    - path: README.md
      role: supporting
```

- `must_open` — failing to return it is a **recall miss**.
- `supporting` — counts toward precision / NDCG, not required for recall.

Judge-free metrics from `artifact.query_evaluation[].provenance`: `recall@k` /
`precision@k` at k∈{1,3,5,10}, `mrr`, `ndcg@10`, `first_gold_rank`, plus cost-normalized
`tokens_per_must_open_file` and `wasted_budget_share`. Reported overall and
**split by `shape`**. Suites without `gold_files` load unchanged.

Optional companions (same positional length):

- `gold_scope` — expected scope landing(s); compared to `scope:` in `retrieval.detail`
  so "searched the wrong subtree" is separable from rank error.
- `probes` — which mechanisms the question is designed to exercise
  (`decoy_guard`, `causal_guard`, `scope_inference`, `unit_size_bias`, `wrong_base`,
  `text_only_index`). The harness reports "feature X fired on A of B target questions"
  and distinguishes **off** / **ran-but-missed** / **fired** (absent vs zero on
  `decoys:` / `causal:` counters).

Every artifact also records `index_fingerprint` (doc/symbol counts + db mtime) and
warns on `binary_source_skew` when `packages/*/dist` is older than `packages/*/src`.

### Annotation discipline

**Never source gold labels from a kb answer.** kb's pipeline — retrieve, LLM-judge
relevance, answer under budget — is structurally the same as the pipeline that would
mint the labels, so labels taken from its curator encode its blind spots as the answer
key and make the very defects the axis exists to catch invisible by construction.
Annotate from the repository, the originating bug, or a PR patch. Leave a question
`null` rather than guess: a wrong answer key is worse than a missing one, and both
"no single owning file" and "the correct answer is a refusal" are legitimate reasons to
skip a question permanently.

**Validate paths against the checkout, not against today's `main`.** A gold path that
is not in the indexed tree can never be recovered, so it silently caps recall and
reports annotation drift as a kb failure:

```bash
node scripts/eval-retrieval-replay.mjs --suite kestra --latest --validate-gold
```

This is not hypothetical. `kestra.yaml` carried
`ui/src/components/flows/create/ImportYaml.vue` after upstream had deleted it; Q12
reported `R@10=0.50` when kb had in fact recovered every file that existed. Vendored
suites track a moving upstream, so re-run the check whenever the clone is refreshed.

**Report `questions_with_gold` beside every retrieval number.** The axis is
deterministic, which makes it read as authoritative — and that is exactly why a narrow
gold set is dangerous. With 3 annotated questions the `kb` suite reported `R@10=0.000`
across six runs with zero variance; at 23 questions the same artifacts report `0.3696`.
Zero variance is not zero uncertainty. This is the retrieval-axis counterpart to
reporting `result_count` beside every cost number.

### Why a deterministic axis (noise floor)

Identical config, same index, same binary can still move LLM-judge correctness by
~0.4 and ΔS by ~0.03 between runs — larger than the effect sizes of the retrieval
guards this milestone measures. Rank-order changes that leave fluent prose alone
register as zero on the rubric. Graded retrieval has no judge variance.

Replay an existing artifact (no re-query):

```bash
pnpm run eval:retrieval-replay -- --suite kb --latest
pnpm run eval:retrieval-replay -- --suite kb --latest --write
pnpm run eval:retrieval-replay -- --all --suite kb
```

## Suites

| Suite | Repo | Notes |
|-------|------|-------|
| `kb` | this repo | self-check / dogfood (includes ambiguity / false-landing probes) |
| `raylib` | raysan5/raylib | primary external C benchmark |
| `fzf` | junegunn/fzf | Go fuzzy finder |
| `kestra` | kestra-io/kestra | Java/UI orchestration (default-10; NiFi-shaped workflows) |
| `shellcheck` | koalaman/shellcheck | Haskell AST linter |
| `lazygit` | jesseduffield/lazygit | Go TUI |
| `datasette` | simonw/datasette | Python explore/publish UI + CLI (default-10) |
| `mitmproxy` | mitmproxy/mitmproxy | Python proxy / TUI |
| `fish-shell` | fish-shell/fish-shell | Rust shell |
| `brew` | Homebrew/brew | Ruby package manager DSL |
| `nifi` | apache/nifi | optional — large; not in `--all-suites` |
| `duckdb` | duckdb/duckdb | optional — large; not in `--all-suites` |
| `generic` | `--repo` required | repo-neutral questions |

## Alias / landing probes

Every suite appends two follow-ups that are still **about the target repo**, not
about kb internals:

1. **Prose landing** — spaced/hyphenated wording for a harvested CamelCase module
   (or the best landable cli/library/repo name on thin registries), often
   “What is the role of the …”, so common-word aliases cannot steal the hit.
2. **Long end-to-end** — a verbose question about how that component fits into
   neighboring subsystems. That exercises entity-resolved fan-out in the
   retriever without asking the *judge* to grade kb’s length-gate policy on a
   brew/fzf/raylib index that has no such concept.

Only the **kb** suite may ask kb-mechanism questions (hybrid retrieval, inquiry
lanes, curator). Other packs must not put “ontology fan-out” or “query-length
gate” in the question or in the gold answer.

## Headline grade (ΔS)

Each suite run (with `--auto-score`, control phase on) produces **`artifact.comparison.success_score.delta_kb_minus_control`** — the single scalar that answers “does kb beat a real agent on this question pack?” Both sides get the same `success_score` formula (quality + tokens + speed). See `EVALUATION.md` § Headline verdict.

```bash
pnpm run eval -- --suite kb --auto-score          # kb + control → ΔS
pnpm run eval -- --suite raylib --auto-score      # primary external benchmark
pnpm run eval -- --suite datasette --skip-control # K-only (control later)
pnpm run eval -- --all-suites                     # 10 default suites (parallel)
```
