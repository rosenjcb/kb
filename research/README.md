---
type: "Guide"
title: "Research Paper"
description: "How to build the KB research paper, a LaTeX two-column article living in this directory."
resource: ./research
tags: [research, latex, paper, results, eval]
timestamp: 2026-06-21T00:00:00Z
---

# Research Paper

**KB: A Facts-First Codebase Knowledge System with Multi-Objective Exploration Loss Evaluation**

The paper lives in this directory as a standard LaTeX two-column article.

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
    latest_results.tex        Single source for headline result macros
    latest-quality.tex        Query quality table driven by latest_results.tex
  figures/              Drop rendered figures here (PDF or PNG)
  generated/            Scratch space for auto-generated assets
```

## Results: single source of truth

Every headline number — `S`, `ΔS`, `S_K`/`S_N`, correctness, pass rate, run ID,
KB token totals — is defined **once** as a macro in `tables/latest_results.tex`
and referenced from `intro.tex`, `eval.tex`, and `conclusion.tex`. This exists
because earlier drafts hardcoded numbers per section and drifted: the abstract
quoted `ΔS = +0.128` from one run while the eval section quoted `ΔS = +0.045`
from another and the conclusion reverted to the first — a reviewer-visible
inconsistency.

Invariants:

- **Never hardcode a result number in a prose section.** Reference the macro from
  `tables/latest_results.tex` so abstract, results, and conclusion cannot
  diverge. `latest-quality.tex` is generated from the same macros.
- **One run is the source for all reported numbers** — the run named by the
  `\LatestResults*` macros. Do not mix runs across sections.
- **The paper does not render init/scan times.** Runtime macros exist in
  `latest_results.tex` for internal reporting only; keep them out of prose.
- **Results cover both targets** (`kb` self-check and `raylib`) and mark control
  rows explicitly when control data was not collected.

The eval harness (`scripts/eval-run.mjs`) writes a per-run `runtime.json` into
each run's workdir (init/scan/docs/graph/logs and per-query durations, plus
`query_total_duration_ms`) and folds it into the run artifact under `runtime`.
That file is the raw timing source; `latest_results.tex` is curated from it by
hand when the paper is refreshed. Runtimes are also a coding signal for agents —
they show where the scan pipeline actually spends time.

## Figures

Three figures are currently placeholder boxes in the PDF. To replace them,
drop a PDF or PNG into `figures/` and swap the `\fbox{\parbox{...}}` block
in the relevant section with:

```latex
\includegraphics[width=\columnwidth]{figures/your-figure.pdf}
```

| Label | Description |
|-------|-------------|
| `fig:system-overview` | End-to-end KB + MOEL flow (intro.tex) |
| `fig:kb-arch` | KB indexing and multi-pond BFS retrieval (method.tex) |

## Output

The compiled PDF is **`research/main.pdf`** — commit it after rebuilding when the paper changes. LaTeX intermediates (`*.aux`, `*.out`, `*.log`, etc.) are gitignored via `research/.gitignore`.
