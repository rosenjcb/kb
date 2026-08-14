---
type: "Guide"
title: "Research Paper"
description: "How to build the KB research paper, a LaTeX two-column article living in this directory."
resource: ./research
tags: [research, latex, paper, results, eval]
timestamp: 2026-06-21T00:00:00Z
---

# Research Paper

**KB: A Hybrid-Retrieval Codebase Knowledge System with Multi-Objective Exploration Loss Evaluation**

The paper lives in this directory as a standard LaTeX two-column article.

## Philosophy: big ideas, not implementation details

The paper (prose *and* figures) should read as the durable core strategy, not
today's tunable knobs. KB's core idea doesn't change release to release: index
a codebase into three retrieval units (documents, code symbols, facts), then on
query fuse lexical and neural lanes over all three with rank fusion, follow a
single depth-1 document↔symbol hop, curate, synthesize. What *does* change
constantly — which judge model scores curation, how many units get dropped per
round, the RRF damping constant, candidate caps — belongs in body prose (where it
can be caveated and dated), never baked into a figure. A diagram full of this
run's magic numbers goes stale before the next eval run finishes.

When adding or editing a figure, ask: would this line still be true after we
retune the retrieval loop? If not, it's an implementation detail — cut it from
the diagram and, if it matters, say it in text instead.

## Prerequisites

You need a TeX Live installation with `latexmk`. On macOS:

```bash
# Full install (~4 GB, never worry about missing packages)
brew install --cask mactex

# Minimal install (~100 MB) — then add the few packages we use
brew install --cask basictex
# Open a NEW terminal after install, then:
sudo tlmgr update --self
sudo tlmgr install latexmk booktabs microtype caption
```

Verify the install worked:

```bash
latexmk --version   # should print Version 4.x
```

## Build

From the repo root:

```bash
pnpm run research:build   # compiles → research/main.pdf
pnpm run research:clean   # removes all latexmk-generated files
```

Or directly from this directory:

```bash
make pdf     # compile
make watch   # auto-recompile on save (opens with system PDF viewer)
make clean   # remove build artifacts
```

VS Code users with the **LaTeX Workshop** extension (`James-Yu.latex-workshop`) get
auto-compile on save out of the box — just open `main.tex`.

## Structure

```
research/
  main.tex              Root document (twocolumn article class)
  refs.bib              BibTeX references (~20 entries)
  Makefile              latexmk targets: pdf / watch / clean
  sections/
    intro.tex           Introduction and contributions
    related.tex         Related work
    method.tex          KB system + MOEL framework (all math)
    eval.tex            Experiments and results tables
    conclusion.tex      Conclusion
  tables/
    benchmark-alignment.tex   MOEL vs SWE Atlas / ContextBench / CodeScaleBench
    results.tex               Auto-generated harvest macros (single source of truth)
    harvest-results.tex       Results table driven by results.tex
    latest_results.tex        Deprecated build-under-test macros (not input by main.tex)
  figures/              Drop rendered figures here (PDF or PNG)
  generated/            Scratch space for auto-generated assets
```

## Results: single source of truth

Every headline number — `S`, `ΔS`, `S_K`/`S_N`, rubric means, token totals, run IDs —
is defined **once** in the auto-generated file `tables/results.tex` and referenced
from `intro.tex`, `eval.tex`, `conclusion.tex`, and `tables/harvest-results.tex`.
This exists because earlier drafts hardcoded numbers per section and drifted.

Invariants:

- **Never hardcode a result number in a prose section.** Reference a macro from
  `tables/results.tex` so abstract, results, and conclusion cannot diverge.
- **One artifact per suite is the source** — the run named by `\RaylibRunId` /
  `\KbSelfCheckRunId` in `results.tex`. Do not mix runs across sections.
- **Regenerate after eval runs:** `pnpm run eval -- --suite … --auto-score` updates
  `results.tex` automatically; or run `pnpm run research:results` by hand.
- **Relevance macros** — `\KbSelfCheckKRelevance`, `\RaylibKRelevance`, etc. feed
  the Rel column in `harvest-results.tex`; adequacy $Q_{\text{adeq}}$ in the paper
  already includes relevance alongside correctness and usefulness.
- **`latest_results.tex` is deprecated** (old build-under-test macros). Do not
  `\input` it from `main.tex`.

The eval harness writes per-run `artifact.json` under `~/.kb/evaluations/`; the
export reads the latest scored artifact for each paper suite.

## The 10 benchmark suites

The paper's harvest table (`tab:harvest-results`) reports on a fixed set of 10
suites: `kb`, `raylib`, `fzf`, `kestra`, `shellcheck`, `lazygit`, `datasette`,
`mitmproxy`, `fish-shell`, `brew`. Each is a question pack at
`eval/suites/<suite>.yaml` (repo URL, questions, display name). `nifi` and
`duckdb` were retired and their YAML files removed (swapped for
`kestra`/`datasette` — oversized repos, replaced with product UI/CLI workflow
questions instead).

The list the paper actually exports is
`RESEARCH_RESULT_SUITES` in `scripts/eval-shared.mjs` — **that array, not the
contents of `eval/suites/`, decides which suites appear in `results.tex`.**
Adding a suite YAML alone does nothing for the paper; it also has to join that
array. Run the harvest with:

```bash
pnpm run eval -- --all-suites --control-agent cursor --control-model composer-2.5
```

(parallel by default; each suite gets kb-side (K) + control-agent-side (N)
answers scored by the same rubric, written to its own `~/.kb/evaluations/<run>/artifact.json`.
`pnpm run research:results` — or the automatic call at the end of `pnpm run eval`
— then re-reads every suite in `RESEARCH_RESULT_SUITES` and regenerates
`results.tex` from scratch, so a stale suite (retired, or renamed) silently
drops out and a newly-added one silently appears the next time it runs.

## Figures: Mermaid, auto-rendered

Figures are **Mermaid diagrams**, not hand-drawn boxes or committed images.
Source lives in `figures/*.mmd`; `pnpm run research:figures` (wired into
`research:build`, so it always runs first) renders every `.mmd` to a same-named
`.pdf` via `scripts/render-figures.mjs` (`@mermaid-js/mermaid-cli`, fit to the
diagram's own bounding box — no oversized canvas padding). `main.tex` sections
just `\includegraphics[width=\columnwidth]{figures/your-figure.pdf}` the result.

| Source | Label | Description |
|--------|-------|-------------|
| `figures/system-overview.mmd` | `fig:system-overview` | End-to-end KB + MOEL flow (intro.tex) |
| `figures/kb-arch.mmd` | `fig:kb-arch` | KB indexing feeding the hybrid rank-fusion retriever (method.tex) |

To add a figure: write `figures/name.mmd`, run `pnpm run research:figures` to
check its rendered aspect ratio (`pdfinfo figures/name.pdf | grep -i "page size"`
— a single LaTeX column is portrait-ish, so a wide-and-short diagram will render
tiny with wasted whitespace; prefer stacking sections top-to-bottom over
side-by-side), then `\includegraphics` it from the relevant section. Keep the
diagram itself at the [conceptual altitude described above](#philosophy-big-ideas-not-implementation-details) —
a handful of labeled stages, not a transcription of every tunable step.

Rendering needs a local Chrome/Chromium (puppeteer can't launch headless
Chrome from cold in this environment). `render-figures.mjs` looks for a system
install automatically; override with `MERMAID_CHROME_PATH` if yours isn't in
one of the default locations.

## Output

The compiled PDF is **`research/main.pdf`** — commit it after rebuilding when the paper changes. LaTeX intermediates (`*.aux`, `*.out`, `*.log`, etc.) are gitignored via `research/.gitignore`.
